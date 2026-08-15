import { createHash, randomBytes as nodeRandomBytes, randomInt, timingSafeEqual } from "node:crypto";
import {
  consumeQqBindingChallenge,
  readQqBotBindings,
  readQqState,
  rememberQqEvent,
  updateQqState,
  upsertQqBotBinding
} from "../store";
import type { QqBotBinding } from "../types";
import { createQqClient } from "./client";
import { QqApiError, type QqDispatchEvent, type QqDirectMessageInput, type QqSendResult } from "./types";

const BINDING_TTL_MS = 10 * 60 * 1000;
const EVENT_DEDUPE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CHALLENGE_KEY = "binding-challenge";
const PRIMARY_BINDING_ID = "primary";

export type QqBindingChallenge = {
  id: string;
  salt: string;
  codeHash: string;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
};

export type QqBindingStorage = {
  readChallenge(): QqBindingChallenge | undefined;
  writeChallenge(challenge: QqBindingChallenge): void;
  consumeChallenge(
    challengeId: string,
    binding: Omit<QqBotBinding, "createdAt" | "updatedAt">,
    consumedAt: string
  ): QqBotBinding | undefined;
  readBinding(): QqBotBinding | undefined;
  updateBinding(
    patch: Partial<Omit<QqBotBinding, "id" | "userOpenId" | "createdAt" | "updatedAt">>,
    updatedAt: string
  ): QqBotBinding | undefined;
  rememberEvent(eventId: string, expiresAt: string): boolean;
};

type QqBindingClient = {
  sendDirectMessage(input: QqDirectMessageInput): Promise<QqSendResult>;
};

export type QqBindingServiceDependencies = {
  storage?: QqBindingStorage;
  client?: QqBindingClient;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
  generateCode?: () => string;
};

function generateBindingCode() {
  let code = "";
  for (let index = 0; index < 6; index += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

function hashCode(salt: string, code: string) {
  return createHash("sha256").update(`${salt}:${code}`).digest("hex");
}

function hashesEqual(left: string, right: string) {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function eventUserOpenId(data: Record<string, unknown>) {
  const direct = data.user_openid ?? data.openid;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const author = data.author;
  if (!author || typeof author !== "object" || Array.isArray(author)) return "";
  const nested = (author as Record<string, unknown>).user_openid ?? (author as Record<string, unknown>).openid;
  return typeof nested === "string" ? nested.trim() : "";
}

function defaultStorage(): QqBindingStorage {
  return {
    readChallenge: () => readQqState<QqBindingChallenge>(CHALLENGE_KEY),
    writeChallenge: (challenge) => updateQqState(CHALLENGE_KEY, challenge),
    consumeChallenge: (challengeId, binding, consumedAt) =>
      consumeQqBindingChallenge(CHALLENGE_KEY, challengeId, binding, consumedAt),
    readBinding: () => readQqBotBindings().find((binding) => binding.id === PRIMARY_BINDING_ID),
    updateBinding: (patch, updatedAt) => {
      const current = readQqBotBindings().find((binding) => binding.id === PRIMARY_BINDING_ID);
      if (!current) return undefined;
      return upsertQqBotBinding({
        id: current.id,
        userOpenId: current.userOpenId,
        friendshipStatus: patch.friendshipStatus ?? current.friendshipStatus,
        proactiveStatus: patch.proactiveStatus ?? current.proactiveStatus,
        lastEventAt: patch.lastEventAt ?? current.lastEventAt,
        lastError: Object.prototype.hasOwnProperty.call(patch, "lastError") ? patch.lastError : current.lastError
      });
    },
    rememberEvent: (eventId, expiresAt) => rememberQqEvent(eventId, expiresAt)
  };
}

export class QqBindingService {
  private readonly storage: QqBindingStorage;
  private readonly client: QqBindingClient;
  private readonly now: () => number;
  private readonly randomBytes: (size: number) => Buffer;
  private readonly generateCode: () => string;

  constructor({
    storage = defaultStorage(),
    client = createQqClient(),
    now = Date.now,
    randomBytes = nodeRandomBytes,
    generateCode = generateBindingCode
  }: QqBindingServiceDependencies = {}) {
    this.storage = storage;
    this.client = client;
    this.now = now;
    this.randomBytes = randomBytes;
    this.generateCode = generateCode;
  }

  createBindingCode() {
    const createdAtMs = this.now();
    const code = this.generateCode();
    if (!/^[A-Z0-9]{6}$/.test(code)) throw new Error("QQ binding code generator returned an invalid code");
    const salt = this.randomBytes(16).toString("hex");
    const challenge: QqBindingChallenge = {
      id: this.randomBytes(16).toString("hex"),
      salt,
      codeHash: hashCode(salt, code),
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: new Date(createdAtMs + BINDING_TTL_MS).toISOString()
    };
    this.storage.writeChallenge(challenge);
    return { code, expiresAt: challenge.expiresAt };
  }

  readBinding() {
    return this.storage.readBinding();
  }

  readChallenge() {
    return this.storage.readChallenge();
  }

  async handleDispatchEvent(event: QqDispatchEvent) {
    if (!event.id) return { kind: "ignored" as const };
    const nowMs = this.now();
    const now = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + EVENT_DEDUPE_TTL_MS).toISOString();
    if (!this.storage.rememberEvent(event.id, expiresAt)) return { kind: "duplicate" as const };

    if (event.type === "C2C_MESSAGE_CREATE") return this.handleBindingMessage(event, now);

    const capability = this.capabilityPatch(event.type);
    if (!capability) return { kind: "ignored" as const };
    const userOpenId = eventUserOpenId(event.data);
    const binding = this.storage.readBinding();
    if (!binding || !userOpenId || binding.userOpenId !== userOpenId) return { kind: "ignored" as const };
    this.storage.updateBinding({ ...capability, lastEventAt: now, lastError: undefined }, now);
    return { kind: "capability" as const };
  }

  private async handleBindingMessage(event: QqDispatchEvent, now: string) {
    const challenge = this.storage.readChallenge();
    const content = typeof event.data.content === "string" ? event.data.content.trim() : "";
    const userOpenId = eventUserOpenId(event.data);
    if (!challenge || challenge.consumedAt || challenge.expiresAt <= now || !content || !userOpenId) {
      return { kind: "ignored" as const };
    }
    if (!hashesEqual(challenge.codeHash, hashCode(challenge.salt, content))) return { kind: "ignored" as const };

    const binding = this.storage.consumeChallenge(
      challenge.id,
      {
        id: PRIMARY_BINDING_ID,
        userOpenId,
        friendshipStatus: "friend",
        proactiveStatus: "unknown",
        lastEventAt: now,
        lastError: undefined
      },
      now
    );
    if (!binding) return { kind: "ignored" as const };

    const messageId = typeof event.data.id === "string" && event.data.id ? event.data.id : event.id;
    try {
      await this.client.sendDirectMessage({
        userOpenId,
        content: "QQ 通知绑定成功。自动邮件系统将按你启用的分类发送提醒。",
        msgId: messageId
      });
    } catch {
      this.storage.updateBinding({ lastError: "passive_confirmation_failed", lastEventAt: now }, now);
    }

    try {
      await this.client.sendDirectMessage({
        userOpenId,
        content: "自动邮件系统 QQ 主动通知测试成功。"
      });
      this.storage.updateBinding({ proactiveStatus: "enabled", lastError: undefined, lastEventAt: now }, now);
    } catch (error) {
      const disabled = error instanceof QqApiError && ["permission", "relationship"].includes(error.kind);
      this.storage.updateBinding(
        {
          proactiveStatus: disabled ? "disabled" : "unknown",
          lastError: error instanceof QqApiError ? error.code ?? error.kind : "proactive_test_failed",
          lastEventAt: now
        },
        now
      );
    }
    return { kind: "bound" as const };
  }

  private capabilityPatch(type: string) {
    if (type === "C2C_MSG_RECEIVE") return { proactiveStatus: "enabled" as const };
    if (type === "C2C_MSG_REJECT") return { proactiveStatus: "disabled" as const };
    if (type === "FRIEND_ADD") return { friendshipStatus: "friend" as const };
    if (type === "FRIEND_DEL") {
      return { friendshipStatus: "removed" as const, proactiveStatus: "disabled" as const };
    }
    return undefined;
  }
}

export function createQqBindingService(dependencies: QqBindingServiceDependencies = {}) {
  return new QqBindingService(dependencies);
}
