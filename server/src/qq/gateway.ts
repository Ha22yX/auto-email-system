import WebSocket from "ws";
import { readQqGatewayState, updateQqGatewayState } from "../store";
import type { QqGatewayState } from "../types";
import { createTokenProvider } from "./credentials";
import {
  QqApiError,
  type QqDispatchEvent,
  type QqGatewayStatus,
  type QqTokenProviderLike
} from "./types";

export const QQ_GATEWAY_URL = "wss://api.bot.qq.com/websocket/";
export const QQ_GROUP_AND_C2C_EVENT_INTENT = 1 << 25;

export const QQ_OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11
} as const;

const SOCKET_OPEN = 1;
const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;
const MAX_GATEWAY_FRAME_BYTES = 1_048_576;

type GatewayFrame = {
  op: number;
  d?: unknown;
  s?: unknown;
  t?: unknown;
  id?: unknown;
};

export type QqGatewaySocket = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
};

export type QqGatewayTimers = {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type QqGatewayDependencies = {
  tokenProvider?: QqTokenProviderLike;
  webSocketFactory?: (url: string) => QqGatewaySocket;
  readState?: () => QqGatewayState | undefined;
  updateState?: (state: Omit<QqGatewayState, "updatedAt">) => QqGatewayState;
  timers?: QqGatewayTimers;
  now?: () => number;
  random?: () => number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  handshakeTimeoutMs?: number;
  onStatus?: (status: QqGatewayStatus) => void;
};

const defaultTimers: QqGatewayTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseFrame(raw: unknown): GatewayFrame | undefined {
  let text: string;
  if (typeof raw === "string") {
    if (Buffer.byteLength(raw) > MAX_GATEWAY_FRAME_BYTES) return undefined;
    text = raw;
  } else if (Buffer.isBuffer(raw)) {
    if (raw.byteLength > MAX_GATEWAY_FRAME_BYTES) return undefined;
    text = raw.toString("utf8");
  } else if (raw instanceof ArrayBuffer) {
    if (raw.byteLength > MAX_GATEWAY_FRAME_BYTES) return undefined;
    text = Buffer.from(raw).toString("utf8");
  } else if (ArrayBuffer.isView(raw)) {
    if (raw.byteLength > MAX_GATEWAY_FRAME_BYTES) return undefined;
    text = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8");
  } else {
    return undefined;
  }

  try {
    const frame = JSON.parse(text) as unknown;
    return isRecord(frame) && Number.isInteger(frame.op) ? (frame as GatewayFrame) : undefined;
  } catch {
    return undefined;
  }
}

function normalizeStoredState(state: QqGatewayState | undefined): Omit<QqGatewayState, "updatedAt"> {
  if (!state) return {};
  const normalized: Omit<QqGatewayState, "updatedAt"> = {};
  if (typeof state.sessionId === "string" && state.sessionId.length > 0) normalized.sessionId = state.sessionId;
  if (typeof state.resumeUrl === "string" && state.resumeUrl.length > 0) normalized.resumeUrl = state.resumeUrl;
  if (Number.isInteger(state.sequence) && Number(state.sequence) >= 0) normalized.sequence = state.sequence;
  if (typeof state.connectedAt === "string" && !Number.isNaN(Date.parse(state.connectedAt))) {
    normalized.connectedAt = state.connectedAt;
  }
  return normalized;
}

function normalizeDispatch(frame: GatewayFrame): QqDispatchEvent | undefined {
  if (!Number.isInteger(frame.s) || Number(frame.s) < 0 || typeof frame.t !== "string" || !frame.t || !isRecord(frame.d)) {
    return undefined;
  }
  if (frame.t === "READY" && (typeof frame.d.session_id !== "string" || !frame.d.session_id)) return undefined;

  const payloadId = typeof frame.d.id === "string" && frame.d.id ? frame.d.id : undefined;
  const frameId = typeof frame.id === "string" && frame.id ? frame.id : undefined;
  return {
    ...(frameId ?? payloadId ? { id: frameId ?? payloadId } : {}),
    type: frame.t,
    sequence: Number(frame.s),
    data: frame.d
  };
}

function isResumable(state: Omit<QqGatewayState, "updatedAt">) {
  return Boolean(state.sessionId) && Number.isInteger(state.sequence) && Number(state.sequence) >= 0;
}

function cloneStatus(status: QqGatewayStatus): QqGatewayStatus {
  return {
    state: status.state,
    reconnectAttempt: status.reconnectAttempt,
    ...(status.connectedAt ? { connectedAt: status.connectedAt } : {}),
    ...(status.lastHeartbeatAckAt ? { lastHeartbeatAckAt: status.lastHeartbeatAckAt } : {}),
    ...(status.lastError ? { lastError: { ...status.lastError } } : {})
  };
}

export class QqGateway {
  private readonly tokenProvider: QqTokenProviderLike;
  private readonly webSocketFactory: (url: string) => QqGatewaySocket;
  private readonly readState: () => QqGatewayState | undefined;
  private readonly updateState: (state: Omit<QqGatewayState, "updatedAt">) => QqGatewayState;
  private readonly timers: QqGatewayTimers;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly onStatusChange?: (status: QqGatewayStatus) => void;
  private readonly dispatchListeners = new Set<(event: QqDispatchEvent) => void>();

  private started = false;
  private socket?: QqGatewaySocket;
  private lifecycleGeneration = 0;
  private socketGeneration = 0;
  private connectionPromise?: Promise<void>;
  private heartbeatTimer?: unknown;
  private handshakeTimer?: unknown;
  private reconnectTimer?: unknown;
  private heartbeatIntervalMs?: number;
  private awaitingHeartbeatAck = false;
  private token?: string;
  private session: Omit<QqGatewayState, "updatedAt"> = {};
  private currentStatus: QqGatewayStatus = { state: "stopped", reconnectAttempt: 0 };

  constructor({
    tokenProvider = createTokenProvider(),
    webSocketFactory = (url) => new WebSocket(url) as unknown as QqGatewaySocket,
    readState = readQqGatewayState,
    updateState = updateQqGatewayState,
    timers = defaultTimers,
    now = Date.now,
    random = Math.random,
    reconnectBaseMs = DEFAULT_RECONNECT_BASE_MS,
    reconnectMaxMs = DEFAULT_RECONNECT_MAX_MS,
    handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
    onStatus
  }: QqGatewayDependencies = {}) {
    this.tokenProvider = tokenProvider;
    this.webSocketFactory = webSocketFactory;
    this.readState = readState;
    this.updateState = updateState;
    this.timers = timers;
    this.now = now;
    this.random = random;
    this.reconnectBaseMs = Math.max(1, reconnectBaseMs);
    this.reconnectMaxMs = Math.max(this.reconnectBaseMs, reconnectMaxMs);
    this.handshakeTimeoutMs = Math.max(1, handshakeTimeoutMs);
    this.onStatusChange = onStatus;
  }

  async start(): Promise<void> {
    if (this.started) {
      await this.connectionPromise;
      return;
    }

    this.started = true;
    this.lifecycleGeneration += 1;
    try {
      this.session = normalizeStoredState(this.readState());
    } catch {
      this.started = false;
      this.setStatus({
        state: "blocked",
        lastError: { code: "state_read_failed", message: "QQ Gateway state could not be read" }
      });
      return;
    }
    await this.ensureConnected();
  }

  async stop(): Promise<void> {
    this.started = false;
    this.lifecycleGeneration += 1;
    this.socketGeneration += 1;
    this.clearHeartbeatTimer();
    this.clearHandshakeTimer();
    this.clearReconnectTimer();
    this.connectionPromise = undefined;
    this.awaitingHeartbeatAck = false;
    this.heartbeatIntervalMs = undefined;
    this.token = undefined;

    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState < 2) {
      try {
        socket.close(1000, "Gateway stopped");
      } catch {
        // The owner is already stopped; a close failure cannot schedule more work.
      }
    }
    this.currentStatus = { state: "stopped", reconnectAttempt: 0 };
    this.publishStatus();
  }

  status(): QqGatewayStatus {
    return cloneStatus(this.currentStatus);
  }

  onDispatch(listener: (event: QqDispatchEvent) => void): () => void {
    this.dispatchListeners.add(listener);
    return () => this.dispatchListeners.delete(listener);
  }

  private async ensureConnected() {
    if (!this.started || this.socket) return;
    if (this.connectionPromise) {
      await this.connectionPromise;
      return;
    }

    const lifecycle = this.lifecycleGeneration;
    const pending = this.openConnection(lifecycle);
    this.connectionPromise = pending;
    try {
      await pending;
    } finally {
      if (this.connectionPromise === pending) this.connectionPromise = undefined;
    }
  }

  private async openConnection(lifecycle: number) {
    this.setStatus({ state: "connecting", lastError: undefined });
    try {
      const token = await this.tokenProvider.getToken();
      if (!this.started || lifecycle !== this.lifecycleGeneration) return;
      this.token = token;
      const socket = this.webSocketFactory(QQ_GATEWAY_URL);
      if (!this.started || lifecycle !== this.lifecycleGeneration) {
        if (socket.readyState < 2) socket.close(1000, "Gateway stopped");
        return;
      }

      this.socket = socket;
      const generation = ++this.socketGeneration;
      socket.on("message", (raw: unknown) => this.handleMessage(socket, generation, raw));
      socket.on("close", (code: number) => this.handleClose(socket, generation, code));
      socket.on("error", () => this.handleSocketError(socket, generation));
    } catch (error) {
      if (!this.started || lifecycle !== this.lifecycleGeneration) return;
      if (error instanceof QqApiError && (error.kind === "authentication" || error.kind === "invalid_request")) {
        this.setStatus({
          state: "blocked",
          lastError: { code: "authentication_failed", message: "QQ Gateway authentication failed" }
        });
        return;
      }
      this.scheduleReconnect("connect_failed", "QQ Gateway connection failed");
    }
  }

  private handleMessage(socket: QqGatewaySocket, generation: number, raw: unknown) {
    if (!this.isCurrentSocket(socket, generation)) return;
    const frame = parseFrame(raw);
    if (!frame) return;

    switch (frame.op) {
      case QQ_OP.HELLO:
        this.handleHello(frame.d);
        break;
      case QQ_OP.DISPATCH:
        this.handleDispatch(frame);
        break;
      case QQ_OP.HEARTBEAT_ACK:
        this.awaitingHeartbeatAck = false;
        this.setStatus({ lastHeartbeatAckAt: this.isoNow() });
        break;
      case QQ_OP.RECONNECT:
        this.requestReconnect("server_reconnect", "QQ Gateway requested reconnect");
        break;
      case QQ_OP.INVALID_SESSION:
        this.handleInvalidSession();
        break;
    }
  }

  private handleHello(data: unknown) {
    if (!isRecord(data) || !Number.isFinite(data.heartbeat_interval) || Number(data.heartbeat_interval) <= 0) {
      this.requestReconnect("invalid_hello", "QQ Gateway sent an invalid Hello frame");
      return;
    }

    this.clearHeartbeatTimer();
    this.heartbeatIntervalMs = Math.max(1, Math.floor(Number(data.heartbeat_interval)));
    this.awaitingHeartbeatAck = false;
    if (isResumable(this.session)) this.sendResume();
    else this.sendIdentify();
    this.scheduleHeartbeat();
  }

  private sendIdentify() {
    if (!this.token) {
      this.requestReconnect("missing_token", "QQ Gateway access token was unavailable");
      return;
    }
    this.setStatus({ state: "identifying", lastError: undefined });
    this.send({
      op: QQ_OP.IDENTIFY,
      d: {
        token: `QQBot ${this.token}`,
        intents: QQ_GROUP_AND_C2C_EVENT_INTENT,
        shard: [0, 1],
        properties: { $os: process.platform, $browser: "auto-email-system", $device: "auto-email-system" }
      }
    });
    this.scheduleHandshakeTimeout("identify");
  }

  private sendResume() {
    if (!this.token || !this.session.sessionId || !Number.isInteger(this.session.sequence)) {
      this.sendIdentify();
      return;
    }
    this.setStatus({ state: "resuming", lastError: undefined });
    this.send({
      op: QQ_OP.RESUME,
      d: {
        token: `QQBot ${this.token}`,
        session_id: this.session.sessionId,
        seq: this.session.sequence
      }
    });
    this.scheduleHandshakeTimeout("resume");
  }

  private handleDispatch(frame: GatewayFrame) {
    const event = normalizeDispatch(frame);
    if (!event) return;

    const next: Omit<QqGatewayState, "updatedAt"> = { ...this.session, sequence: event.sequence };
    if (event.type === "READY") {
      next.sessionId = String(event.data.session_id);
      next.connectedAt = this.isoNow();
      const resumeUrl = event.data.resume_gateway_url;
      if (typeof resumeUrl === "string" && resumeUrl.startsWith("wss://")) next.resumeUrl = resumeUrl;
    } else if (event.type === "RESUMED") {
      next.connectedAt = this.isoNow();
    }
    this.session = next;

    try {
      this.updateState(next);
    } catch {
      this.setStatus({
        lastError: { code: "state_write_failed", message: "QQ Gateway session state could not be saved" }
      });
    }

    if (event.type === "READY" || event.type === "RESUMED") {
      this.clearHandshakeTimer();
      this.currentStatus.reconnectAttempt = 0;
      this.setStatus({ state: "online", connectedAt: next.connectedAt, lastError: undefined });
    }
    for (const listener of this.dispatchListeners) {
      try {
        listener(event);
      } catch {
        // A consumer cannot break protocol handling for other listeners.
      }
    }
  }

  private handleInvalidSession() {
    this.clearHandshakeTimer();
    this.clearSession();
    this.sendIdentify();
  }

  private clearSession() {
    this.session = {};
    try {
      this.updateState({});
    } catch {
      this.setStatus({
        lastError: { code: "state_write_failed", message: "QQ Gateway session state could not be cleared" }
      });
    }
  }

  private scheduleHeartbeat() {
    if (!this.started || !this.heartbeatIntervalMs) return;
    this.clearHeartbeatTimer();
    this.heartbeatTimer = this.timers.setTimeout(() => {
      this.heartbeatTimer = undefined;
      if (!this.started || !this.socket) return;
      if (this.awaitingHeartbeatAck) {
        this.requestReconnect("heartbeat_timeout", "QQ Gateway heartbeat was not acknowledged");
        return;
      }
      this.awaitingHeartbeatAck = true;
      this.send({ op: QQ_OP.HEARTBEAT, d: this.session.sequence ?? null });
      this.scheduleHeartbeat();
    }, this.heartbeatIntervalMs);
  }

  private send(frame: Record<string, unknown>) {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) {
      this.requestReconnect("socket_unavailable", "QQ Gateway socket was unavailable");
      return;
    }
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      this.requestReconnect("send_failed", "QQ Gateway send failed");
    }
  }

  private handleClose(socket: QqGatewaySocket, generation: number, code: number) {
    if (!this.isCurrentSocket(socket, generation)) return;
    this.socket = undefined;
    this.clearHeartbeatTimer();
    this.clearHandshakeTimer();
    this.awaitingHeartbeatAck = false;
    if (!this.started) return;
    if (code === 4006 || code === 4007 || code === 4009) {
      this.clearSession();
      this.scheduleReconnect("session_invalid", "QQ Gateway session was invalid");
      return;
    }
    if (code === 4004) {
      this.tokenProvider.invalidate(this.token);
      this.token = undefined;
      this.clearSession();
      this.scheduleReconnect("authentication_closed", "QQ Gateway authentication was rejected");
      return;
    }
    const safeCode = Number.isInteger(code) && code >= 1000 && code <= 4999 ? String(code) : "unknown";
    this.scheduleReconnect("socket_closed", `QQ Gateway socket closed (${safeCode})`);
  }

  private handleSocketError(socket: QqGatewaySocket, generation: number) {
    if (!this.isCurrentSocket(socket, generation)) return;
    this.requestReconnect("socket_error", "QQ Gateway socket failed");
  }

  private requestReconnect(code: string, message: string) {
    if (!this.started || this.reconnectTimer) return;
    this.clearHeartbeatTimer();
    this.clearHandshakeTimer();
    this.awaitingHeartbeatAck = false;
    this.heartbeatIntervalMs = undefined;

    const socket = this.socket;
    this.socket = undefined;
    this.socketGeneration += 1;
    if (socket && socket.readyState < 2) {
      try {
        socket.close(4000, "Gateway reconnecting");
      } catch {
        // Reconnect scheduling below remains authoritative.
      }
    }
    this.scheduleReconnect(code, message);
  }

  private scheduleReconnect(code: string, message: string) {
    if (!this.started || this.reconnectTimer) return;
    const attempt = this.currentStatus.reconnectAttempt + 1;
    const baseDelay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** Math.min(attempt - 1, 30));
    const random = Math.min(1, Math.max(0, this.random()));
    const delay = Math.min(
      this.reconnectMaxMs,
      Math.max(1, Math.round(baseDelay * (0.75 + random * 0.5)))
    );
    this.setStatus({ state: "reconnecting", reconnectAttempt: attempt, lastError: { code, message } });
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.started) void this.ensureConnected();
    }, delay);
  }

  private clearHeartbeatTimer() {
    if (this.heartbeatTimer === undefined) return;
    this.timers.clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private scheduleHandshakeTimeout(mode: "identify" | "resume") {
    this.clearHandshakeTimer();
    this.handshakeTimer = this.timers.setTimeout(() => {
      this.handshakeTimer = undefined;
      if (!this.started || !this.socket) return;
      if (mode === "resume") this.clearSession();
      this.requestReconnect(
        mode + "_timeout",
        mode === "resume"
          ? "QQ Gateway Resume handshake timed out"
          : "QQ Gateway Identify handshake timed out"
      );
    }, this.handshakeTimeoutMs);
  }

  private clearHandshakeTimer() {
    if (this.handshakeTimer === undefined) return;
    this.timers.clearTimeout(this.handshakeTimer);
    this.handshakeTimer = undefined;
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer === undefined) return;
    this.timers.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private isCurrentSocket(socket: QqGatewaySocket, generation: number) {
    return this.started && this.socket === socket && this.socketGeneration === generation;
  }

  private isoNow() {
    return new Date(this.now()).toISOString();
  }

  private setStatus(patch: Partial<QqGatewayStatus>) {
    this.currentStatus = { ...this.currentStatus, ...patch };
    this.publishStatus();
  }

  private publishStatus() {
    if (!this.onStatusChange) return;
    try {
      this.onStatusChange(cloneStatus(this.currentStatus));
    } catch {
      // Status publication cannot own or interrupt the Gateway lifecycle.
    }
  }
}

export function createQqGateway(dependencies: QqGatewayDependencies = {}) {
  return new QqGateway(dependencies);
}
