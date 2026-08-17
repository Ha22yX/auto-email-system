import {
  findQqEmailReadAction,
  getProcessedEmailById,
  markQqEmailReadActionUsed,
  updateProcessedEmailPanelRead
} from "../store";
import type { ProcessedEmail, QqBotBinding, QqEmailReadAction } from "../types";
import { qqEventUserOpenId } from "./quote-read";
import type { QqDirectMessageInput, QqDispatchEvent, QqSendResult } from "./types";

type QqButtonReadClient = {
  acknowledgeInteraction(interactionId: string): Promise<void>;
  sendDirectMessage(input: QqDirectMessageInput): Promise<QqSendResult>;
};

export type QqButtonReadServiceDependencies = {
  readBinding: () => QqBotBinding | undefined;
  findAction?: (token: string, userOpenId: string) => QqEmailReadAction | undefined;
  readEmail?: (id: string) => ProcessedEmail | undefined;
  markPanelRead?: (id: string, panelRead: boolean) => ProcessedEmail;
  markActionUsed?: (token: string) => string;
  client: QqButtonReadClient;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function parseQqMailReadInteraction(event: QqDispatchEvent) {
  if (event.type !== "INTERACTION_CREATE") return undefined;
  const data = record(event.data.data);
  const nestedData = record(data?.data);
  const resolved = record(data?.resolved)
    ?? record(event.data.resolved)
    ?? record(nestedData?.resolved);
  const buttonData = text(resolved?.button_data)
    ?? text(resolved?.callback_data)
    ?? text(resolved?.buttonData);
  const match = buttonData?.match(/^mail-read:([a-f0-9]{32})$/i);
  if (!match) return undefined;
  const interactionId = text(event.data.id) ?? event.id;
  return interactionId ? { interactionId, token: match[1].toLowerCase() } : undefined;
}

function confirmation(email: ProcessedEmail, alreadyRead: boolean) {
  const subject = (email.subject || "无主题").replace(/\s+/g, " ").trim();
  const compact = subject.length > 48 ? `${subject.slice(0, 47).trim()}...` : subject;
  return alreadyRead
    ? `这封邮件已经是系统已读。\n《${compact}》`
    : `已标记为系统已读。\n《${compact}》\n邮件处理台已同步更新。`;
}

export class QqButtonReadService {
  private readonly readBinding: () => QqBotBinding | undefined;
  private readonly findAction: NonNullable<QqButtonReadServiceDependencies["findAction"]>;
  private readonly readEmail: NonNullable<QqButtonReadServiceDependencies["readEmail"]>;
  private readonly markPanelRead: NonNullable<QqButtonReadServiceDependencies["markPanelRead"]>;
  private readonly markActionUsed: NonNullable<QqButtonReadServiceDependencies["markActionUsed"]>;
  private readonly client: QqButtonReadClient;

  constructor(dependencies: QqButtonReadServiceDependencies) {
    this.readBinding = dependencies.readBinding;
    this.findAction = dependencies.findAction ?? findQqEmailReadAction;
    this.readEmail = dependencies.readEmail ?? getProcessedEmailById;
    this.markPanelRead = dependencies.markPanelRead ?? updateProcessedEmailPanelRead;
    this.markActionUsed = dependencies.markActionUsed ?? markQqEmailReadActionUsed;
    this.client = dependencies.client;
  }

  async handleDispatchEvent(event: QqDispatchEvent) {
    const interaction = parseQqMailReadInteraction(event);
    if (!interaction) return { kind: "ignored" as const };

    let acknowledgementFailed = false;
    try {
      await this.client.acknowledgeInteraction(interaction.interactionId);
    } catch {
      acknowledgementFailed = true;
    }

    const binding = this.readBinding();
    const userOpenId = qqEventUserOpenId(event.data);
    if (!binding || !userOpenId || binding.userOpenId !== userOpenId) {
      return { kind: "unauthorized" as const, acknowledgementFailed };
    }

    const action = this.findAction(interaction.token, userOpenId);
    if (!action) return { kind: "unknown-action" as const, acknowledgementFailed };
    const current = this.readEmail(action.emailId);
    if (!current) return { kind: "email-missing" as const, acknowledgementFailed };

    const alreadyRead = Boolean(current.panelRead);
    const email = alreadyRead ? current : this.markPanelRead(current.id, true);
    this.markActionUsed(action.token);

    let confirmationFailed = false;
    let confirmationReferenced = false;
    try {
      await this.client.sendDirectMessage({
        userOpenId,
        content: confirmation(email, alreadyRead),
        ...(action.messageId ? { messageReferenceId: action.messageId } : {})
      });
      confirmationReferenced = Boolean(action.messageId);
    } catch {
      if (action.messageId) {
        try {
          await this.client.sendDirectMessage({
            userOpenId,
            content: confirmation(email, alreadyRead)
          });
        } catch {
          confirmationFailed = true;
        }
      } else {
        confirmationFailed = true;
      }
    }
    return {
      kind: alreadyRead ? "already-read" as const : "marked-read" as const,
      emailId: email.id,
      acknowledgementFailed,
      confirmationFailed,
      confirmationReferenced
    };
  }
}

export function createQqButtonReadService(dependencies: QqButtonReadServiceDependencies) {
  return new QqButtonReadService(dependencies);
}
