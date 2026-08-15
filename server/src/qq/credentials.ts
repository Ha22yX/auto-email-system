import { decryptCredential } from "../credential-crypto";
import { readQqBotConfig } from "../store";
import type { QqBotConfig } from "../types";
import { QQ_API_ORIGIN, QqApiError, type QqApiErrorKind } from "./types";

const TOKEN_REFRESH_SAFETY_MS = 90_000;
const TOKEN_ENDPOINT = `${QQ_API_ORIGIN}/app/getAppAccessToken`;

type TokenCache = { value: string; expiresAt: number };

type QqFetch = (url: string, init?: RequestInit) => Promise<Response>;

export type QqTokenProviderDependencies = {
  fetch?: QqFetch;
  readConfig?: () => QqBotConfig;
  decryptCredential?: (envelope: string) => string;
  now?: () => number;
};

function errorKindForStatus(status: number): QqApiErrorKind {
  if (status === 401) return "authentication";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "transient";
  return "invalid_request";
}

function errorCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as Record<string, unknown>).code ?? (body as Record<string, unknown>).err_code;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value)) return value;
  return undefined;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export class QqTokenProvider {
  private cache: TokenCache | undefined;
  private inFlight: Promise<string> | undefined;
  private readonly fetch: QqFetch;
  private readonly readConfig: () => QqBotConfig;
  private readonly decryptCredential: (envelope: string) => string;
  private readonly now: () => number;

  constructor({
    fetch = globalThis.fetch.bind(globalThis),
    readConfig = readQqBotConfig,
    decryptCredential: decrypt = decryptCredential,
    now = Date.now
  }: QqTokenProviderDependencies = {}) {
    this.fetch = fetch;
    this.readConfig = readConfig;
    this.decryptCredential = decrypt;
    this.now = now;
  }

  async getToken(options: { force?: boolean } = {}): Promise<string> {
    if (!options.force && this.cache && this.now() < this.cache.expiresAt - TOKEN_REFRESH_SAFETY_MS) {
      return this.cache.value;
    }
    if (this.inFlight) return this.inFlight;

    const request = this.requestToken();
    this.inFlight = request;
    try {
      return await request;
    } finally {
      if (this.inFlight === request) this.inFlight = undefined;
    }
  }

  invalidate() {
    this.cache = undefined;
  }

  clear() {
    this.invalidate();
  }

  private async requestToken(): Promise<string> {
    const config = this.readConfig();
    if (!config.appId.trim() || !config.encryptedAppSecret) {
      throw new QqApiError({
        kind: "invalid_request",
        status: 0,
        code: "credentials_missing",
        message: "QQ bot credentials are not configured"
      });
    }

    let response: Response;
    try {
      response = await this.fetch(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appId: config.appId.trim(),
          clientSecret: this.decryptCredential(config.encryptedAppSecret)
        })
      });
    } catch (error) {
      if (error instanceof QqApiError) throw error;
      throw new QqApiError({
        kind: "transient",
        status: 0,
        message: "QQ token request failed"
      });
    }

    const body = await readJson(response);
    if (!response.ok) {
      throw new QqApiError({
        kind: errorKindForStatus(response.status),
        status: response.status,
        code: errorCode(body)
      });
    }

    const token = body && typeof body === "object" ? (body as Record<string, unknown>).access_token : undefined;
    const expiresIn = body && typeof body === "object" ? (body as Record<string, unknown>).expires_in : undefined;
    if (typeof token !== "string" || !token || typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new QqApiError({
        kind: "transient",
        status: response.status,
        code: "invalid_token_response",
        message: "QQ token response was invalid"
      });
    }

    this.cache = { value: token, expiresAt: this.now() + expiresIn * 1000 };
    return token;
  }
}

export function createTokenProvider(dependencies: QqTokenProviderDependencies = {}) {
  return new QqTokenProvider(dependencies);
}
