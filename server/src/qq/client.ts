import { createTokenProvider } from "./credentials";
import {
  QQ_API_ORIGIN,
  QqApiError,
  type QqApiErrorKind,
  type QqDirectImageInput,
  type QqDirectMessageInput,
  type QqSendResult,
  type QqTokenProviderLike
} from "./types";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_NOTIFICATION_IMAGE_BYTES = 5 * 1024 * 1024;

type QqFetch = (url: string, init?: RequestInit) => Promise<Response>;
type QqResponseBody = Record<string, unknown> | undefined;

export type QqClientDependencies = {
  fetch?: QqFetch;
  tokenProvider?: QqTokenProviderLike;
  timeoutMs?: number;
  now?: () => number;
};

function readErrorCode(body: QqResponseBody): string | undefined {
  const value = body?.code ?? body?.err_code;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value)) return value;
  return undefined;
}

const AUTHENTICATION_ERROR_CODES = new Set(["11241", "11243"]);
const RATE_LIMIT_ERROR_CODES = new Set(["20028", "1100100", "1100308"]);
const TRANSIENT_ERROR_CODES = new Set(["11242", "11252", "11263", "11281", "1100300", "1100499"]);
const PERMISSION_ERROR_CODES = new Set(["11253", "11254", "11282", "11264", "11274", "304004", "304014"]);

function errorKindFor(status: number, code: string | undefined): QqApiErrorKind {
  if (code && AUTHENTICATION_ERROR_CODES.has(code)) return "authentication";
  if (code && RATE_LIMIT_ERROR_CODES.has(code)) return "rate_limited";
  if (code && TRANSIENT_ERROR_CODES.has(code)) return "transient";
  if (code && PERMISSION_ERROR_CODES.has(code)) return "permission";
  if (status === 401) return "authentication";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "transient";
  if (status === 403) return "permission";
  return "invalid_request";
}

function parseRetryAfterMs(headers: Headers, now: number): number | undefined {
  const retryAfter = headers.get("retry-after");
  if (!retryAfter) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(retryAfter);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

async function readJson(response: Response): Promise<QqResponseBody> {
  try {
    const body = await response.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export class QqClient {
  private readonly fetch: QqFetch;
  private readonly tokenProvider: QqTokenProviderLike;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private messageSequence = 0;

  constructor({
    fetch = globalThis.fetch.bind(globalThis),
    tokenProvider = createTokenProvider(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    now = Date.now
  }: QqClientDependencies = {}) {
    this.fetch = fetch;
    this.tokenProvider = tokenProvider;
    this.timeoutMs = timeoutMs;
    this.now = now;
  }

  async sendDirectMessage(input: QqDirectMessageInput): Promise<QqSendResult> {
    if (!input.userOpenId.trim() || !input.content.trim()) {
      throw new QqApiError({ kind: "invalid_request", status: 0, code: "invalid_message_input", message: "QQ direct message requires a recipient and content" });
    }
    return this.withTokenRefresh((token) => this.sendTextWithToken(input, token));
  }

  async sendDirectImage(input: QqDirectImageInput): Promise<QqSendResult> {
    if (!input.userOpenId.trim() || !input.image.length || input.image.length > MAX_NOTIFICATION_IMAGE_BYTES) {
      throw new QqApiError({ kind: "invalid_request", status: 0, code: "invalid_image_input", message: "QQ direct image requires a recipient and a bounded image" });
    }
    return this.withTokenRefresh((token) => this.sendImageWithToken(input, token));
  }

  private async withTokenRefresh<T>(operation: (token: string) => Promise<T>): Promise<T> {
    const token = await this.tokenProvider.getToken();
    try {
      return await operation(token);
    } catch (error) {
      if (!(error instanceof QqApiError) || error.kind !== "authentication") throw error;
    }
    const invalidated = this.tokenProvider.invalidate(token);
    const refreshedToken = invalidated === false
      ? await this.tokenProvider.getToken()
      : await this.tokenProvider.getToken({ force: true });
    return operation(refreshedToken);
  }

  private async requestJson(url: string, payload: Record<string, unknown>, token: string) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetch(url, {
        method: "POST",
        headers: { authorization: `QQBot ${token}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } catch {
      throw new QqApiError({ kind: "transient", status: 0, message: "QQ direct-message request failed" });
    } finally {
      clearTimeout(timeout);
    }
    const body = await readJson(response);
    if (!response.ok) {
      const code = readErrorCode(body);
      throw new QqApiError({
        kind: errorKindFor(response.status, code),
        status: response.status,
        code,
        retryAfterMs: response.status === 429 ? parseRetryAfterMs(response.headers, this.now()) : undefined
      });
    }
    return body;
  }

  private async sendTextWithToken(input: QqDirectMessageInput, token: string): Promise<QqSendResult> {
    const payload: Record<string, unknown> = { content: input.content, msg_type: 0 };
    if (input.msgId) payload.msg_id = input.msgId;
    const body = await this.requestJson(`${QQ_API_ORIGIN}/v2/users/${encodeURIComponent(input.userOpenId)}/messages`, payload, token);
    return this.sendResult(body);
  }

  private async sendImageWithToken(input: QqDirectImageInput, token: string): Promise<QqSendResult> {
    const base = `${QQ_API_ORIGIN}/v2/users/${encodeURIComponent(input.userOpenId)}`;
    const uploaded = await this.requestJson(`${base}/files`, {
      file_type: 1,
      file_data: input.image.toString("base64"),
      file_name: input.fileName || "mail-summary.png",
      srv_send_msg: false
    }, token);
    const fileInfo = uploaded?.file_info;
    if (typeof fileInfo !== "string" || !fileInfo) {
      throw new QqApiError({ kind: "invalid_request", status: 0, code: "missing_file_info", message: "QQ media upload returned no file_info" });
    }
    this.messageSequence = (this.messageSequence % 10_000) + 1;
    const body = await this.requestJson(`${base}/messages`, {
      msg_type: 7,
      msg_seq: this.messageSequence,
      media: { file_info: fileInfo }
    }, token);
    return this.sendResult(body);
  }

  private sendResult(body: QqResponseBody): QqSendResult {
    const messageId = body?.id ?? body?.message_id;
    return typeof messageId === "string" ? { messageId } : {};
  }
}

export function createQqClient(dependencies: QqClientDependencies = {}) {
  return new QqClient(dependencies);
}
