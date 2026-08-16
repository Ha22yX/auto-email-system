import {
  findQqNotificationReference,
  getProcessedEmailById,
  readQqBotConfig,
  updateProcessedEmailPanelRead
} from "../store";
import type { ProcessedEmail, QqBotBinding, QqBotConfig, QqNotificationReference } from "../types";
import type { QqDirectMessageInput, QqDispatchEvent, QqSendResult } from "./types";

const QUOTE_MESSAGE_TYPE = 103;

export type QqQuoteReference = {
  messageId?: string;
  refIndex?: string;
};

type QqQuoteReadClient = {
  sendDirectMessage(input: QqDirectMessageInput): Promise<QqSendResult>;
};

export type QqQuoteReadServiceDependencies = {
  readConfig?: () => QqBotConfig;
  readBinding: () => QqBotBinding | undefined;
  findReference?: (input: {
    userOpenId: string;
    messageId?: string;
    refIndex?: string;
  }) => QqNotificationReference | undefined;
  readEmail?: (id: string) => ProcessedEmail | undefined;
  markPanelRead?: (id: string, panelRead: boolean) => ProcessedEmail;
  client: QqQuoteReadClient;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function qqEventUserOpenId(data: Record<string, unknown>) {
  const direct = text(data.user_openid) ?? text(data.openid);
  if (direct) return direct;
  const author = record(data.author);
  return text(author?.user_openid) ?? text(author?.openid) ?? "";
}

export function parseQqQuoteReference(event: QqDispatchEvent): QqQuoteReference | undefined {
  if (event.type !== "C2C_MESSAGE_CREATE") return undefined;
  const data = event.data;
  let refIndex = text(data.ref_msg_idx);
  let messageId: string | undefined;

  const scene = record(data.message_scene);
  const ext = scene?.ext;
  if (Array.isArray(ext)) {
    for (const entry of ext) {
      if (typeof entry !== "string") continue;
      const separator = entry.indexOf("=");
      if (separator < 0) continue;
      const key = entry.slice(0, separator).trim();
      const value = entry.slice(separator + 1).trim();
      if (key === "ref_msg_idx" && value) refIndex = value;
    }
  }

  const elements = data.msg_elements;
  if (Number(data.message_type) === QUOTE_MESSAGE_TYPE && Array.isArray(elements)) {
    const first = record(elements[0]);
    refIndex = text(first?.msg_idx) ?? refIndex;
    messageId = text(first?.message_id) ?? text(first?.id) ?? messageId;
  }

  const messageReference = record(data.message_reference);
  messageId = text(messageReference?.message_id) ?? text(data.ref_message_id) ?? messageId;
  return refIndex || messageId ? { ...(messageId ? { messageId } : {}), ...(refIndex ? { refIndex } : {}) } : undefined;
}

function incomingMessageId(event: QqDispatchEvent) {
  return text(event.data.id) ?? event.id;
}

function confirmation(email: ProcessedEmail, alreadyRead: boolean) {
  const subject = (email.subject || "无主题").replace(/\s+/g, " ").trim();
  const compactSubject = subject.length > 48 ? subject.slice(0, 47).trim() + "..." : subject;
  return alreadyRead
    ? "这封邮件已经是系统已读。\n《" + compactSubject + "》"
    : "已标记为系统已读。\n《" + compactSubject + "》\n邮件处理台已同步更新。";
}

export class QqQuoteReadService {
  private readonly readConfig: () => QqBotConfig;
  private readonly readBinding: () => QqBotBinding | undefined;
  private readonly findReference: NonNullable<QqQuoteReadServiceDependencies["findReference"]>;
  private readonly readEmail: NonNullable<QqQuoteReadServiceDependencies["readEmail"]>;
  private readonly markPanelRead: NonNullable<QqQuoteReadServiceDependencies["markPanelRead"]>;
  private readonly client: QqQuoteReadClient;

  constructor({
    readConfig = readQqBotConfig,
    readBinding,
    findReference = findQqNotificationReference,
    readEmail = getProcessedEmailById,
    markPanelRead = updateProcessedEmailPanelRead,
    client
  }: QqQuoteReadServiceDependencies) {
    this.readConfig = readConfig;
    this.readBinding = readBinding;
    this.findReference = findReference;
    this.readEmail = readEmail;
    this.markPanelRead = markPanelRead;
    this.client = client;
  }

  async handleDispatchEvent(event: QqDispatchEvent) {
    if (!this.readConfig().quoteImageMarksRead) return { kind: "disabled" as const };
    const reference = parseQqQuoteReference(event);
    if (!reference) return { kind: "ignored" as const };

    const binding = this.readBinding();
    const userOpenId = qqEventUserOpenId(event.data);
    if (!binding || !userOpenId || binding.userOpenId !== userOpenId) {
      return { kind: "unauthorized" as const };
    }

    const stored = this.findReference({ userOpenId, ...reference });
    if (!stored) return { kind: "unknown-reference" as const };
    const current = this.readEmail(stored.emailId);
    if (!current) return { kind: "email-missing" as const };

    const alreadyRead = Boolean(current.panelRead);
    const email = alreadyRead ? current : this.markPanelRead(current.id, true);
    try {
      await this.client.sendDirectMessage({
        userOpenId,
        content: confirmation(email, alreadyRead),
        ...(incomingMessageId(event) ? { msgId: incomingMessageId(event) } : {})
      });
      return { kind: alreadyRead ? "already-read" as const : "marked-read" as const, emailId: email.id };
    } catch {
      return {
        kind: alreadyRead ? "already-read" as const : "marked-read" as const,
        emailId: email.id,
        confirmationFailed: true
      };
    }
  }
}

export function createQqQuoteReadService(dependencies: QqQuoteReadServiceDependencies) {
  return new QqQuoteReadService(dependencies);
}