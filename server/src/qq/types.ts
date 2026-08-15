export const QQ_API_ORIGIN = "https://api.bot.qq.com";

export type QqApiErrorKind =
  | "authentication"
  | "rate_limited"
  | "transient"
  | "permission"
  | "relationship"
  | "invalid_request";

export type QqApiErrorOptions = {
  kind: QqApiErrorKind;
  status: number;
  code?: string;
  retryAfterMs?: number;
  message?: string;
};

export class QqApiError extends Error {
  readonly kind: QqApiErrorKind;
  readonly status: number;
  readonly code?: string;
  readonly retryAfterMs?: number;

  constructor({ kind, status, code, retryAfterMs, message }: QqApiErrorOptions) {
    super(message ?? `QQ API ${kind} failure${status ? ` (${status})` : ""}`);
    this.name = "QqApiError";
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export type QqDirectMessageInput = {
  userOpenId: string;
  content: string;
  msgId?: string;
};

export type QqSendResult = {
  messageId?: string;
};

export type QqTokenProviderLike = {
  getToken(options?: { force?: boolean }): Promise<string>;
  invalidate(token?: string): boolean | void;
};

export type QqGatewayConnectionState =
  | "stopped"
  | "connecting"
  | "identifying"
  | "resuming"
  | "online"
  | "reconnecting"
  | "blocked";

export type QqGatewayStatus = {
  state: QqGatewayConnectionState;
  reconnectAttempt: number;
  connectedAt?: string;
  lastHeartbeatAckAt?: string;
  lastError?: {
    code: string;
    message: string;
  };
};

export type QqDispatchEvent = {
  id?: string;
  type: string;
  sequence: number;
  data: Record<string, unknown>;
};
