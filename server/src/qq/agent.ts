import { createHash, randomUUID } from "node:crypto";
import { classifyEmail } from "../ai";
import { buildProviderRequest, extractProviderText } from "../ai-adapters";
import { resolveAiEndpoint, resolveAiProtocol } from "../ai-protocol";
import { countUnreadImap } from "../email/imap";
import { countUnreadPop3 } from "../email/pop3";
import {
  getEmailStats,
  getProcessedEmailById,
  markProcessedEmailsPanelRead,
  pauseNotificationDelivery,
  queryNotificationDeliveries,
  queryProcessedEmails,
  readMailboxes,
  readProcessingRuns,
  readQqBotConfig,
  readQqState,
  readSettings,
  recordQqAgentEvent,
  retryNotificationDeliveriesByChannel,
  retryNotificationDelivery,
  resumeNotificationDelivery,
  updateProcessedEmailCategory,
  updateProcessedEmailClassification,
  updateProcessedEmailPanelRead,
  updateQqState
} from "../store";
import type {
  MailCategory,
  Mailbox,
  NotificationDeliveryListItem,
  ProcessedEmail,
  ProcessingRun,
  QqAgentPermission,
  QqAgentSettings,
  QqBotBinding,
  QqBotConfig
} from "../types";
import { qqEventUserOpenId } from "./quote-read";
import type { QqDirectMessageInput, QqDispatchEvent, QqSendResult } from "./types";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CONFIRMATION_TTL_MS = 10 * 60 * 1000;
const MAX_TOOL_CALLS = 4;
const MAX_QQ_MESSAGE_CHARS = 1800;

const categoryLabels: Record<MailCategory, string> = {
  important: "重要",
  secondary: "次重要",
  ignore: "不用管"
};

const defaultAgentPermissions: Record<QqAgentPermission, boolean> = {
  readMail: true,
  manageReadState: true,
  manageNotifications: true,
  runProcessing: true,
  checkMailboxes: true,
  reclassifyMail: true
};

const defaultAgentSettings: QqAgentSettings = {
  enabled: false,
  requireConfirmation: true,
  maxResults: 6,
  permissions: defaultAgentPermissions
};

const toolNames = [
  "mail.search",
  "mail.listRecent",
  "mail.getDetail",
  "mail.listByCategory",
  "mail.stats",
  "mail.markPanelRead",
  "mail.markCategoryRead",
  "mail.markMailboxRead",
  "mail.reclassifyOne",
  "mail.moveCategory",
  "mailbox.list",
  "mailbox.healthCheck",
  "mailbox.syncOne",
  "notification.listFailed",
  "notification.retryOne",
  "notification.retryAllFailed",
  "notification.pauseOne",
  "notification.resumeOne",
  "run.status",
  "process.status",
  "process.runAll",
  "process.runMailbox"
] as const;

export type QqAgentToolName = (typeof toolNames)[number];

export type QqAgentToolCall = {
  name: QqAgentToolName;
  arguments?: Record<string, unknown>;
};

type QqAgentClient = {
  sendDirectMessage(input: QqDirectMessageInput): Promise<QqSendResult>;
};

type AgentEmailRef = {
  index: number;
  id: string;
  subject: string;
};

type AgentNotificationRef = {
  index: number;
  id: string;
  emailId?: string;
  subject?: string;
};

type PendingAction = {
  id: string;
  toolCall: QqAgentToolCall;
  summary: string;
  createdAt: string;
  expiresAt: string;
};

type LastList = {
  toolCall: QqAgentToolCall;
  nextOffset: number;
};

type AgentSession = {
  userOpenId: string;
  history: Array<{ role: "user" | "assistant"; content: string; at: string }>;
  lastEmails: AgentEmailRef[];
  lastNotifications: AgentNotificationRef[];
  lastList?: LastList;
  pendingAction?: PendingAction;
  updatedAt: string;
};

type ToolResult = {
  name: QqAgentToolName;
  ok: boolean;
  message: string;
  data?: unknown;
  emailRefs?: AgentEmailRef[];
  notificationRefs?: AgentNotificationRef[];
  nextPageTool?: LastList;
  pendingAction?: PendingAction;
};

type AgentPlan = {
  reply?: string;
  toolCalls: QqAgentToolCall[];
};

type QqAgentServiceDependencies = {
  readConfig?: () => QqBotConfig;
  readBinding: () => QqBotBinding | undefined;
  client: QqAgentClient;
  now?: () => number;
  fetch?: typeof fetch;
  classify?: typeof classifyEmail;
  countUnreadImap?: typeof countUnreadImap;
  countUnreadPop3?: typeof countUnreadPop3;
};

const toolNameSet = new Set<string>(toolNames);

const writeTools = new Set<QqAgentToolName>([
  "mail.markPanelRead",
  "mail.markCategoryRead",
  "mail.markMailboxRead",
  "mail.reclassifyOne",
  "mail.moveCategory",
  "mailbox.syncOne",
  "notification.retryOne",
  "notification.retryAllFailed",
  "notification.pauseOne",
  "notification.resumeOne",
  "process.runAll",
  "process.runMailbox"
]);

const toolPermissions: Record<QqAgentToolName, QqAgentPermission> = {
  "mail.search": "readMail",
  "mail.listRecent": "readMail",
  "mail.getDetail": "readMail",
  "mail.listByCategory": "readMail",
  "mail.stats": "readMail",
  "mail.markPanelRead": "manageReadState",
  "mail.markCategoryRead": "manageReadState",
  "mail.markMailboxRead": "manageReadState",
  "mail.reclassifyOne": "reclassifyMail",
  "mail.moveCategory": "reclassifyMail",
  "mailbox.list": "checkMailboxes",
  "mailbox.healthCheck": "checkMailboxes",
  "mailbox.syncOne": "runProcessing",
  "notification.listFailed": "manageNotifications",
  "notification.retryOne": "manageNotifications",
  "notification.retryAllFailed": "manageNotifications",
  "notification.pauseOne": "manageNotifications",
  "notification.resumeOne": "manageNotifications",
  "run.status": "readMail",
  "process.status": "readMail",
  "process.runAll": "runProcessing",
  "process.runMailbox": "runProcessing"
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boolArg(value: unknown, fallback: boolean) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (/^(true|1|yes|y|on|是|开启|打开|确认)$/i.test(value.trim())) return true;
    if (/^(false|0|no|n|off|否|关闭|取消)$/i.test(value.trim())) return false;
  }
  return fallback;
}

function intArg(value: unknown, fallback: number) {
  const parsed = typeof value === "number" ? value : Number(String(value ?? ""));
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function truncate(value: string, limit: number) {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit - 3).trim()}...` : compact;
}

function safeSubject(email: Pick<ProcessedEmail, "subject">) {
  return truncate(email.subject || "无主题", 80);
}

function formatAt(value?: string) {
  if (!value) return "未知时间";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function formatDate(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}

function normalizeAgentSettings(config: QqBotConfig): QqAgentSettings {
  const source = config.agent ?? defaultAgentSettings;
  const maxResults = intArg(source.maxResults, defaultAgentSettings.maxResults);
  return {
    enabled: Boolean(source.enabled),
    requireConfirmation: Boolean(source.requireConfirmation ?? true),
    maxResults: Math.min(10, Math.max(3, maxResults)),
    permissions: {
      ...defaultAgentPermissions,
      ...(source.permissions ?? {})
    }
  };
}

function sessionKey(userOpenId: string) {
  const digest = createHash("sha256").update(userOpenId).digest("hex");
  return `agent-session:${digest}`;
}

function incomingMessageId(event: QqDispatchEvent) {
  return text(event.data.id) ?? event.id;
}

function incomingText(event: QqDispatchEvent) {
  if (event.type !== "C2C_MESSAGE_CREATE") return "";
  const raw = text(event.data.content) ?? "";
  return raw.replace(/<@![^>]+>/g, "").replace(/<@[^>]+>/g, "").trim();
}

function parseJsonObject(textValue: string) {
  const trimmed = textValue.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]?.trim().startsWith("{")) return fenced[1].trim();
  return trimmed.match(/\{[\s\S]*\}/)?.[0] ?? "";
}

function normalizeToolCall(value: unknown): QqAgentToolCall | undefined {
  if (!isRecord(value)) return undefined;
  const name = text(value.name);
  if (!name || !toolNameSet.has(name)) return undefined;
  const args = isRecord(value.arguments) ? value.arguments : isRecord(value.args) ? value.args : {};
  return { name: name as QqAgentToolName, arguments: args };
}

function normalizePlan(value: unknown): AgentPlan {
  const item = isRecord(value) ? value : {};
  const toolCalls = Array.isArray(item.toolCalls)
    ? item.toolCalls.flatMap((entry) => {
        const call = normalizeToolCall(entry);
        return call ? [call] : [];
      })
    : [];
  return {
    reply: text(item.reply),
    toolCalls: toolCalls.slice(0, MAX_TOOL_CALLS)
  };
}

function isConfirm(value: string) {
  return /^(确认|确定|执行|同意|可以|好|好的|yes|y|ok|okay)$/i.test(value.trim());
}

function isCancel(value: string) {
  return /^(取消|不用|算了|否|不要|停止|no|n|cancel)$/i.test(value.trim());
}

function isContinue(value: string) {
  return /^(继续|下一页|更多|more|next)$/i.test(value.trim());
}

function parseCategory(value: unknown): MailCategory | undefined {
  const normalized = text(value)?.toLowerCase();
  if (!normalized) return undefined;
  if (["important", "重要", "主要", "紧急"].includes(normalized)) return "important";
  if (["secondary", "次重要", "次要", "普通", "一般"].includes(normalized)) return "secondary";
  if (["ignore", "不用管", "忽略", "垃圾", "推广"].includes(normalized)) return "ignore";
  return undefined;
}

function localDayRange(offsetDays = 0) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + offsetDays);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { since: start.toISOString(), until: end.toISOString() };
}

function localWeekRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const day = start.getDay() || 7;
  start.setDate(start.getDate() - day + 1);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return { since: start.toISOString(), until: end.toISOString() };
}

function rangeFromArgs(args: Record<string, unknown>) {
  const since = text(args.since);
  const until = text(args.until);
  if (since || until) {
    return {
      since: since && !Number.isNaN(Date.parse(since)) ? new Date(since).toISOString() : undefined,
      until: until && !Number.isNaN(Date.parse(until)) ? new Date(until).toISOString() : undefined
    };
  }
  const period = text(args.period)?.toLowerCase();
  if (period === "today" || period === "今天") return localDayRange(0);
  if (period === "yesterday" || period === "昨天") return localDayRange(-1);
  if (period === "week" || period === "this_week" || period === "本周") return localWeekRange();
  return {};
}

function categoryFromMessage(message: string) {
  if (/次重要|次要|普通/.test(message)) return "secondary" as const;
  if (/不用管|忽略|垃圾|推广/.test(message)) return "ignore" as const;
  if (/重要|紧急/.test(message)) return "important" as const;
  return undefined;
}

function periodFromMessage(message: string) {
  if (/今天|今日/.test(message)) return "today";
  if (/昨天|昨日/.test(message)) return "yesterday";
  if (/本周|这周|最近一周/.test(message)) return "week";
  return undefined;
}

function indexFromMessage(message: string) {
  const match = message.match(/第\s*(\d{1,2})\s*(?:封|条|个)?|看\s*(\d{1,2})|重试\s*(\d{1,2})|暂停\s*(\d{1,2})|恢复\s*(\d{1,2})/);
  const value = match ? Number(match[1] || match[2] || match[3] || match[4] || match[5]) : NaN;
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function messagePeriodArgs(message: string) {
  const period = periodFromMessage(message);
  return period ? { period } : {};
}

function formatMailboxName(mailboxId?: string) {
  if (!mailboxId || mailboxId === "all") return "全部邮箱";
  return readMailboxes().find((mailbox) => mailbox.id === mailboxId)?.name ?? "指定邮箱";
}

function summarizeRun(run: ProcessingRun | undefined, running: boolean) {
  if (!run) return running ? "有处理任务正在运行。" : "当前没有处理记录。";
  const lines = [
    running ? "当前正在处理邮件。" : `最近一次处理：${run.status === "success" ? "成功" : run.status === "failed" ? "有错误" : "运行中"}`,
    `阶段：${run.currentStage || "无"}`,
    `数量：已处理 ${run.processedCount} 封，重要 ${run.importantCount}，次重要 ${run.secondaryCount}，不用管 ${run.ignoreCount}`
  ];
  if (run.currentMailboxName) lines.push(`邮箱：${run.currentMailboxName}`);
  if (run.currentSubject) lines.push(`当前邮件：${truncate(run.currentSubject, 60)}`);
  if (run.errors.length) lines.push(`错误：${truncate(run.errors[run.errors.length - 1] || "", 120)}`);
  return lines.join("\n");
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function helpText() {
  return [
    "QQ 智能体已开启。你可以这样说：",
    "1. 今天重要邮件有哪些",
    "2. 搜索 Grab receipt",
    "3. 看第 2 封",
    "4. 把第 2 封标记已读",
    "5. QQ 通知失败有哪些",
    "6. 重试全部失败通知",
    "7. 处理全部邮箱 / 处理 Gmail 邮箱",
    "8. 检查邮箱连接",
    "写操作会先让我确认，再回复“确认”执行。"
  ].join("\n");
}

function formatEmails(title: string, emails: ProcessedEmail[], mailboxes: Mailbox[], offset = 0) {
  if (!emails.length) return `${title}\n没有找到符合条件的邮件。`;
  const mailboxMap = new Map(mailboxes.map((mailbox) => [mailbox.id, mailbox]));
  const lines = emails.map((email, index) => {
    const number = offset + index + 1;
    const mailbox = mailboxMap.get(email.mailboxId)?.name ?? "未知邮箱";
    const sender = email.fromName || email.fromAddress || "未知发件人";
    return [
      `${number}. [${categoryLabels[email.category]}] ${safeSubject(email)}`,
      `   ${formatAt(email.receivedAt || email.processedAt)} · ${mailbox} · ${truncate(sender, 32)}`,
      `   ${truncate(email.summaryZh || "无摘要", 90)}`
    ].join("\n");
  });
  return `${title}\n${lines.join("\n")}`;
}

function emailRefs(emails: ProcessedEmail[], offset = 0): AgentEmailRef[] {
  return emails.map((email, index) => ({
    index: offset + index + 1,
    id: email.id,
    subject: safeSubject(email)
  }));
}

function formatNotifications(title: string, notifications: NotificationDeliveryListItem[], offset = 0) {
  if (!notifications.length) return `${title}\n没有符合条件的 QQ 通知记录。`;
  return `${title}\n${notifications.map((item, index) => {
    const number = offset + index + 1;
    const subject = item.email?.subject ? safeSubject({ subject: item.email.subject }) : item.emailId;
    const status = item.status === "paused" ? "已暂停" : item.status === "retry" ? "待重试" : item.status;
    const error = item.lastError ? `\n   ${truncate(item.lastError, 100)}` : "";
    return `${number}. ${subject}\n   ${status} · 尝试 ${item.attemptCount} 次 · ${formatAt(item.updatedAt)}${error}`;
  }).join("\n")}`;
}

function notificationRefs(notifications: NotificationDeliveryListItem[], offset = 0): AgentNotificationRef[] {
  return notifications.map((item, index) => ({
    index: offset + index + 1,
    id: item.id,
    emailId: item.emailId,
    subject: item.email?.subject ? safeSubject({ subject: item.email.subject }) : undefined
  }));
}

export class QqAgentService {
  private readonly readConfig: () => QqBotConfig;
  private readonly readBinding: () => QqBotBinding | undefined;
  private readonly client: QqAgentClient;
  private readonly now: () => number;
  private readonly fetch: typeof fetch;
  private readonly classify: typeof classifyEmail;
  private readonly countUnreadImap: typeof countUnreadImap;
  private readonly countUnreadPop3: typeof countUnreadPop3;
  private readonly inFlightUsers = new Set<string>();

  constructor({
    readConfig = readQqBotConfig,
    readBinding,
    client,
    now = Date.now,
    fetch = globalThis.fetch.bind(globalThis),
    classify = classifyEmail,
    countUnreadImap: imapCounter = countUnreadImap,
    countUnreadPop3: popCounter = countUnreadPop3
  }: QqAgentServiceDependencies) {
    this.readConfig = readConfig;
    this.readBinding = readBinding;
    this.client = client;
    this.now = now;
    this.fetch = fetch;
    this.classify = classify;
    this.countUnreadImap = imapCounter;
    this.countUnreadPop3 = popCounter;
  }

  async handleDispatchEvent(event: QqDispatchEvent) {
    if (event.type !== "C2C_MESSAGE_CREATE") return { kind: "ignored" as const };
    const config = this.readConfig();
    const agent = normalizeAgentSettings(config);
    if (!agent.enabled) return { kind: "disabled" as const };

    const binding = this.readBinding();
    const userOpenId = qqEventUserOpenId(event.data);
    if (!binding || !userOpenId || binding.userOpenId !== userOpenId) return { kind: "unauthorized" as const };

    const message = incomingText(event);
    if (!message) return { kind: "ignored" as const };

    if (this.inFlightUsers.has(userOpenId)) {
      await this.sendReply(userOpenId, "上一条消息还在处理，请稍等一下。", incomingMessageId(event));
      return { kind: "busy" as const };
    }

    this.inFlightUsers.add(userOpenId);
    try {
      const session = this.readSession(userOpenId, agent);
      this.appendHistory(session, "user", message, agent);
      recordQqAgentEvent({ userOpenId, kind: "message", status: "received", message });
      const reply = await this.respond(message, session, agent);
      this.appendHistory(session, "assistant", reply, agent);
      this.saveSession(session, agent);
      await this.sendReply(userOpenId, reply, incomingMessageId(event));
      return { kind: "handled" as const };
    } catch (error) {
      const safeMessage = error instanceof Error ? error.message : String(error);
      recordQqAgentEvent({ userOpenId, kind: "error", status: "failed", message: safeMessage });
      await this.sendReply(userOpenId, `这次处理失败了：${truncate(safeMessage, 140)}`, incomingMessageId(event));
      return { kind: "failed" as const };
    } finally {
      this.inFlightUsers.delete(userOpenId);
    }
  }

  private async respond(message: string, session: AgentSession, agent: QqAgentSettings) {
    if (session.pendingAction && session.pendingAction.expiresAt <= new Date(this.now()).toISOString()) {
      session.pendingAction = undefined;
    }

    if (session.pendingAction && isConfirm(message)) {
      const action = session.pendingAction;
      session.pendingAction = undefined;
      const result = await this.executeTool(action.toolCall, session, agent, true);
      return result.message;
    }

    if (session.pendingAction && isCancel(message)) {
      const summary = session.pendingAction.summary;
      session.pendingAction = undefined;
      return `已取消：${summary}`;
    }

    if (isContinue(message)) {
      if (!session.lastList) return "没有可以继续展开的列表。你可以先搜索邮件或查看最近邮件。";
      const result = await this.executeTool(session.lastList.toolCall, session, agent, false);
      return result.message;
    }

    if (session.pendingAction) session.pendingAction = undefined;

    const localPlan = this.heuristicPlan(message, session);
    const plan = localPlan ?? await this.aiPlan(message, session, agent);
    if (!plan.toolCalls.length) return plan.reply || helpText();

    const results: ToolResult[] = [];
    for (const call of plan.toolCalls.slice(0, MAX_TOOL_CALLS)) {
      const result = await this.executeTool(call, session, agent, false);
      results.push(result);
      if (result.emailRefs) session.lastEmails = result.emailRefs;
      if (result.notificationRefs) session.lastNotifications = result.notificationRefs;
      session.lastList = result.nextPageTool;
      if (result.pendingAction) {
        session.pendingAction = result.pendingAction;
        return result.message;
      }
    }

    return results.map((result) => result.message).join("\n\n") || plan.reply || helpText();
  }

  private heuristicPlan(message: string, session: AgentSession): AgentPlan | undefined {
    if (/^(帮助|help|菜单|你会什么)$/i.test(message.trim())) return { reply: helpText(), toolCalls: [] };
    const index = indexFromMessage(message);
    if (/通知/.test(message) && /失败|队列|异常|错误/.test(message)) {
      return { toolCalls: [{ name: "notification.listFailed", arguments: messagePeriodArgs(message) }] };
    }
    if (/^(状态|进度)$|处理.*(状态|进度)|运行.*(状态|进度)/.test(message)) {
      return { toolCalls: [{ name: "process.status", arguments: {} }] };
    }
    if (/邮箱.*(列表|有哪些|配置)/.test(message)) {
      return { toolCalls: [{ name: "mailbox.list", arguments: {} }] };
    }
    if (/检查.*邮箱|邮箱.*检查|邮箱.*健康|连接.*邮箱/.test(message)) {
      return { toolCalls: [{ name: "mailbox.healthCheck", arguments: {} }] };
    }
    if (/统计|多少封|数量/.test(message)) {
      return { toolCalls: [{ name: "mail.stats", arguments: messagePeriodArgs(message) }] };
    }
    if (/重试.*全部.*通知|全部.*失败.*重试/.test(message)) {
      return { toolCalls: [{ name: "notification.retryAllFailed", arguments: {} }] };
    }
    if (/重试/.test(message) && /通知/.test(message) && index) {
      return { toolCalls: [{ name: "notification.retryOne", arguments: { index } }] };
    }
    if (/暂停/.test(message) && /通知/.test(message) && index) {
      return { toolCalls: [{ name: "notification.pauseOne", arguments: { index } }] };
    }
    if (/恢复/.test(message) && /通知/.test(message) && index) {
      return { toolCalls: [{ name: "notification.resumeOne", arguments: { index } }] };
    }
    if (/处理.*全部邮箱|全部邮箱.*处理/.test(message)) {
      return { toolCalls: [{ name: "process.runAll", arguments: {} }] };
    }
    if (/处理|同步/.test(message) && /邮箱/.test(message)) {
      const mailboxName = message.replace(/处理|同步|邮箱|一下|新的|邮件/g, " ").trim();
      return { toolCalls: [{ name: /同步/.test(message) ? "mailbox.syncOne" : "process.runMailbox", arguments: { mailboxName } }] };
    }
    if (/重新分类|重新判断|重分类/.test(message) && index) {
      return { toolCalls: [{ name: "mail.reclassifyOne", arguments: { index } }] };
    }
    if (/改成|归为|设为/.test(message)) {
      const category = categoryFromMessage(message);
      if (category && index) return { toolCalls: [{ name: "mail.moveCategory", arguments: { index, category } }] };
    }
    if (/标记.*已读|已读/.test(message) && (index || /这封|上一封|上一条/.test(message))) {
      return { toolCalls: [{ name: "mail.markPanelRead", arguments: { index: index ?? session.lastEmails[0]?.index ?? 1, panelRead: true } }] };
    }
    const searchMatch = message.match(/^(?:搜索|查找|查|找)\s+(.+)$/);
    if (searchMatch?.[1]?.trim()) {
      return { toolCalls: [{ name: "mail.search", arguments: { query: searchMatch[1].trim() } }] };
    }
    if (/最近|最新/.test(message)) {
      return { toolCalls: [{ name: "mail.listRecent", arguments: messagePeriodArgs(message) }] };
    }
    const category = categoryFromMessage(message);
    if (category && /邮件/.test(message)) {
      return { toolCalls: [{ name: "mail.listByCategory", arguments: { category, ...messagePeriodArgs(message) } }] };
    }
    if (/看|详情|打开/.test(message) && index) {
      return { toolCalls: [{ name: "mail.getDetail", arguments: { index } }] };
    }
    return undefined;
  }

  private async aiPlan(message: string, session: AgentSession, agent: QqAgentSettings): Promise<AgentPlan> {
    const settings = readSettings().ai;
    if (!settings.apiKey.trim()) {
      return {
        reply: "AI API Key 还没配置好，所以我只能响应固定指令。\n\n" + helpText(),
        toolCalls: []
      };
    }

    const systemPrompt = [
      "你是自动邮件系统的 QQ 智能体。你通过 QQ 单聊帮助已绑定用户查看和处理邮件。",
      "只能输出严格 JSON，不要 Markdown。",
      "JSON 字段：reply, toolCalls。reply 是无需工具时的简短中文回复；toolCalls 是工具调用数组。",
      "不要编造邮件内容。需要邮件数据时必须调用工具。",
      "写操作可以提出工具调用，后端会自动二次确认。",
      "可用工具：",
      "mail.search { query, category?, mailboxId?, period?, limit?, offset? }",
      "mail.listRecent { mailboxId?, period?, limit?, offset? }",
      "mail.getDetail { emailId? 或 index? }",
      "mail.listByCategory { category, mailboxId?, period?, limit?, offset? }",
      "mail.stats { mailboxId?, period?, since?, until? }",
      "mail.markPanelRead { emailId? 或 index?, panelRead? }",
      "mail.markCategoryRead { category, mailboxId? }",
      "mail.markMailboxRead { mailboxId? 或 mailboxName? }",
      "mail.reclassifyOne { emailId? 或 index? }",
      "mail.moveCategory { emailId? 或 index?, category }",
      "mailbox.list {}",
      "mailbox.healthCheck { mailboxId? 或 mailboxName? }",
      "mailbox.syncOne { mailboxId? 或 mailboxName? }",
      "notification.listFailed { limit?, offset? }",
      "notification.retryOne { deliveryId? 或 index? }",
      "notification.retryAllFailed {}",
      "notification.pauseOne { deliveryId? 或 index? }",
      "notification.resumeOne { deliveryId? 或 index? }",
      "run.status {}",
      "process.status {}",
      "process.runAll {}",
      "process.runMailbox { mailboxId? 或 mailboxName? }",
      "category 只能是 important、secondary、ignore。period 只能是 today、yesterday、week、all。"
    ].join("\n");

    const prompt = [
      `当前时间：${new Date(this.now()).toISOString()}`,
      `每次列表最多返回：${agent.maxResults}`,
      "最近邮件序号：",
      session.lastEmails.map((item) => `${item.index}. ${item.id} ${item.subject}`).join("\n") || "(无)",
      "最近通知序号：",
      session.lastNotifications.map((item) => `${item.index}. ${item.id} ${item.subject ?? item.emailId ?? ""}`).join("\n") || "(无)",
      "最近对话：",
      session.history.slice(-6).map((item) => `${item.role}: ${item.content}`).join("\n") || "(无)",
      "",
      `用户消息：${message}`
    ].join("\n");

    const protocol = resolveAiProtocol(settings, "text");
    const { url, init } = buildProviderRequest({
      protocol,
      url: resolveAiEndpoint(settings, "text"),
      apiKey: settings.apiKey,
      model: settings.model,
      temperature: Math.min(settings.temperature ?? 0.1, 0.2),
      systemPrompt,
      userPrompt: prompt
    });
    const response = await this.fetchWithTimeout(url, init, 30000);
    if (!response.ok) {
      const detail = (await response.text()).replaceAll(settings.apiKey, "[REDACTED]");
      throw new Error(`QQ Agent AI 请求失败 ${response.status}: ${detail.slice(0, 240)}`);
    }
    const jsonText = parseJsonObject(extractProviderText(protocol, await response.json()));
    if (!jsonText) return { reply: "我没能理解这条消息。你可以说“帮助”看可用指令。", toolCalls: [] };
    return normalizePlan(JSON.parse(jsonText));
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("QQ Agent AI 请求超时。");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async executeTool(
    call: QqAgentToolCall,
    session: AgentSession,
    agent: QqAgentSettings,
    confirmed: boolean
  ): Promise<ToolResult> {
    const permission = toolPermissions[call.name];
    if (!agent.permissions[permission]) {
      return { name: call.name, ok: false, message: `这个工具没有开启权限：${call.name}` };
    }

    const concreteCall = this.concreteToolCall(call, session);
    if (writeTools.has(concreteCall.name) && agent.requireConfirmation && !confirmed) {
      const summary = this.describeWriteTool(concreteCall, session);
      const now = new Date(this.now());
      const pendingAction: PendingAction = {
        id: randomUUID(),
        toolCall: concreteCall,
        summary,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + CONFIRMATION_TTL_MS).toISOString()
      };
      recordQqAgentEvent({
        userOpenId: session.userOpenId,
        kind: "tool",
        status: "pending",
        toolName: concreteCall.name,
        message: summary,
        data: concreteCall.arguments
      });
      return {
        name: concreteCall.name,
        ok: true,
        message: `${summary}\n\n回复“确认”执行，回复“取消”放弃。有效至 ${formatDate(pendingAction.expiresAt)}。`,
        pendingAction
      };
    }

    try {
      const result = await this.runTool(concreteCall, session, agent);
      recordQqAgentEvent({
        userOpenId: session.userOpenId,
        kind: "tool",
        status: result.ok ? "success" : "failed",
        toolName: concreteCall.name,
        message: result.message,
        data: result.data ?? concreteCall.arguments
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordQqAgentEvent({
        userOpenId: session.userOpenId,
        kind: "tool",
        status: "failed",
        toolName: concreteCall.name,
        message,
        data: concreteCall.arguments
      });
      return { name: concreteCall.name, ok: false, message: `${concreteCall.name} 执行失败：${truncate(message, 140)}` };
    }
  }

  private concreteToolCall(call: QqAgentToolCall, session: AgentSession): QqAgentToolCall {
    const args = { ...(call.arguments ?? {}) };
    if (!text(args.emailId) && args.index !== undefined) {
      const ref = this.emailRefFromArgs(args, session);
      if (ref) args.emailId = ref.id;
    }
    if (!text(args.deliveryId) && args.index !== undefined) {
      const ref = this.notificationRefFromArgs(args, session);
      if (ref) args.deliveryId = ref.id;
    }
    if (!text(args.mailboxId) && text(args.mailboxName)) {
      const mailbox = this.mailboxFromArgs(args);
      if (mailbox) args.mailboxId = mailbox.id;
    }
    return { name: call.name, arguments: args };
  }

  private describeWriteTool(call: QqAgentToolCall, session: AgentSession) {
    const args = call.arguments ?? {};
    switch (call.name) {
      case "mail.markPanelRead": {
        const email = this.emailFromArgs(args, session);
        return `确认将《${email ? safeSubject(email) : "指定邮件"}》标记为${boolArg(args.panelRead, true) ? "系统已读" : "系统未读"}？`;
      }
      case "mail.markCategoryRead": {
        const category = parseCategory(args.category) ?? "important";
        return `确认将 ${formatMailboxName(text(args.mailboxId))} 的“${categoryLabels[category]}”邮件全部标记为系统已读？`;
      }
      case "mail.markMailboxRead": {
        const mailbox = this.mailboxFromArgs(args);
        return `确认将 ${mailbox?.name ?? "指定邮箱"} 的全部邮件标记为系统已读？`;
      }
      case "mail.reclassifyOne": {
        const email = this.emailFromArgs(args, session);
        return `确认重新 AI 分类《${email ? safeSubject(email) : "指定邮件"}》？`;
      }
      case "mail.moveCategory": {
        const email = this.emailFromArgs(args, session);
        const category = parseCategory(args.category) ?? "secondary";
        return `确认将《${email ? safeSubject(email) : "指定邮件"}》改为“${categoryLabels[category]}”？`;
      }
      case "notification.retryOne": {
        const ref = this.notificationRefFromArgs(args, session);
        return `确认重试 QQ 通知《${ref?.subject ?? ref?.emailId ?? "指定通知"}》？`;
      }
      case "notification.retryAllFailed":
        return "确认重试全部失败或暂停的 QQ 通知？";
      case "notification.pauseOne": {
        const ref = this.notificationRefFromArgs(args, session);
        return `确认暂停 QQ 通知《${ref?.subject ?? ref?.emailId ?? "指定通知"}》？`;
      }
      case "notification.resumeOne": {
        const ref = this.notificationRefFromArgs(args, session);
        return `确认恢复 QQ 通知《${ref?.subject ?? ref?.emailId ?? "指定通知"}》？`;
      }
      case "process.runAll":
        return "确认立即处理全部已启用邮箱？";
      case "process.runMailbox": {
        const mailbox = this.mailboxFromArgs(args);
        return `确认立即处理 ${mailbox?.name ?? "指定邮箱"}？`;
      }
      case "mailbox.syncOne": {
        const mailbox = this.mailboxFromArgs(args);
        return `确认立即同步 ${mailbox?.name ?? "指定邮箱"} 的新邮件？`;
      }
      default:
        return `确认执行 ${call.name}？`;
    }
  }

  private async runTool(call: QqAgentToolCall, session: AgentSession, agent: QqAgentSettings): Promise<ToolResult> {
    const args = call.arguments ?? {};
    const limit = Math.min(agent.maxResults, Math.max(1, intArg(args.limit, agent.maxResults)));
    const offset = Math.max(0, intArg(args.offset, 0));
    switch (call.name) {
      case "mail.search":
        return this.toolSearchMail(call, args, limit, offset);
      case "mail.listRecent":
        return this.toolListRecent(call, args, limit, offset);
      case "mail.getDetail":
        return this.toolGetDetail(call, args, session);
      case "mail.listByCategory":
        return this.toolListByCategory(call, args, limit, offset);
      case "mail.stats":
        return this.toolMailStats(call, args);
      case "mail.markPanelRead":
        return this.toolMarkPanelRead(call, args, session);
      case "mail.markCategoryRead":
        return this.toolMarkCategoryRead(call, args);
      case "mail.markMailboxRead":
        return this.toolMarkMailboxRead(call, args);
      case "mail.reclassifyOne":
        return this.toolReclassify(call, args, session);
      case "mail.moveCategory":
        return this.toolMoveCategory(call, args, session);
      case "mailbox.list":
        return this.toolMailboxList(call);
      case "mailbox.healthCheck":
        return this.toolMailboxHealth(call, args);
      case "mailbox.syncOne":
      case "process.runMailbox":
        return this.toolRunMailbox(call, args, session.userOpenId);
      case "notification.listFailed":
        return this.toolNotificationFailed(call, limit, offset);
      case "notification.retryOne":
        return this.toolNotificationRetryOne(call, args, session);
      case "notification.retryAllFailed":
        return this.toolNotificationRetryAll(call);
      case "notification.pauseOne":
        return this.toolNotificationPauseOne(call, args, session);
      case "notification.resumeOne":
        return this.toolNotificationResumeOne(call, args, session);
      case "run.status":
      case "process.status":
        return this.toolProcessStatus(call);
      case "process.runAll":
        return this.toolRunAll(call, session.userOpenId);
    }
  }

  private queryOptions(args: Record<string, unknown>, limit: number, offset: number) {
    return {
      category: parseCategory(args.category),
      mailboxId: text(args.mailboxId),
      q: text(args.query) ?? text(args.q) ?? "",
      ...rangeFromArgs(args),
      offset,
      limit
    };
  }

  private toolSearchMail(call: QqAgentToolCall, args: Record<string, unknown>, limit: number, offset: number): ToolResult {
    const query = text(args.query) ?? text(args.q);
    if (!query) return { name: call.name, ok: false, message: "请告诉我要搜索什么关键词。" };
    const result = queryProcessedEmails({ ...this.queryOptions(args, limit, offset), q: query });
    const message = formatEmails(`搜索“${truncate(query, 30)}”的结果：`, result.items, readMailboxes(), offset);
    return {
      name: call.name,
      ok: true,
      message: result.hasMoreAfter ? `${message}\n\n回复“继续”查看更多。` : message,
      emailRefs: emailRefs(result.items, offset),
      nextPageTool: result.hasMoreAfter ? { toolCall: { ...call, arguments: { ...args, offset: offset + result.items.length } }, nextOffset: offset + result.items.length } : undefined,
      data: { total: result.total }
    };
  }

  private toolListRecent(call: QqAgentToolCall, args: Record<string, unknown>, limit: number, offset: number): ToolResult {
    const result = queryProcessedEmails(this.queryOptions(args, limit, offset));
    const message = formatEmails("最近邮件：", result.items, readMailboxes(), offset);
    return {
      name: call.name,
      ok: true,
      message: result.hasMoreAfter ? `${message}\n\n回复“继续”查看更多。` : message,
      emailRefs: emailRefs(result.items, offset),
      nextPageTool: result.hasMoreAfter ? { toolCall: { ...call, arguments: { ...args, offset: offset + result.items.length } }, nextOffset: offset + result.items.length } : undefined,
      data: { total: result.total }
    };
  }

  private toolListByCategory(call: QqAgentToolCall, args: Record<string, unknown>, limit: number, offset: number): ToolResult {
    const category = parseCategory(args.category) ?? "important";
    const result = queryProcessedEmails({ ...this.queryOptions(args, limit, offset), category });
    const message = formatEmails(`${categoryLabels[category]}邮件：`, result.items, readMailboxes(), offset);
    return {
      name: call.name,
      ok: true,
      message: result.hasMoreAfter ? `${message}\n\n回复“继续”查看更多。` : message,
      emailRefs: emailRefs(result.items, offset),
      nextPageTool: result.hasMoreAfter ? { toolCall: { ...call, arguments: { ...args, category, offset: offset + result.items.length } }, nextOffset: offset + result.items.length } : undefined,
      data: { total: result.total }
    };
  }

  private toolGetDetail(call: QqAgentToolCall, args: Record<string, unknown>, session: AgentSession): ToolResult {
    const email = this.emailFromArgs(args, session);
    if (!email) return { name: call.name, ok: false, message: "我没找到这封邮件。可以先搜索或查看最近邮件，再说“看第 2 封”。" };
    const actions = email.actionItemsZh.length
      ? email.actionItemsZh.map((item, index) => `${index + 1}. ${truncate(item, 120)}`).join("\n")
      : "无明确动作。";
    const body = truncate(email.originalText || email.reasonZh || "", 500);
    return {
      name: call.name,
      ok: true,
      message: [
        `《${safeSubject(email)}》`,
        `分类：${categoryLabels[email.category]}`,
        `时间：${formatDate(email.receivedAt || email.processedAt)}`,
        `发件人：${email.fromName || ""} <${email.fromAddress || "未知"}>`,
        `摘要：${email.summaryZh}`,
        `动作：\n${actions}`,
        body ? `正文摘录：${body}` : ""
      ].filter(Boolean).join("\n"),
      emailRefs: [{ index: 1, id: email.id, subject: safeSubject(email) }],
      data: { emailId: email.id }
    };
  }

  private toolMailStats(call: QqAgentToolCall, args: Record<string, unknown>): ToolResult {
    const range = rangeFromArgs(args);
    const stats = getEmailStats({ mailboxId: text(args.mailboxId), ...range });
    const rangeText = range.since || range.until
      ? `范围：${range.since ? formatDate(range.since) : "开始"} 至 ${range.until ? formatDate(range.until) : "现在"}`
      : "范围：全部";
    return {
      name: call.name,
      ok: true,
      message: [
        "邮件统计：",
        rangeText,
        `总数：${stats.total}，系统未读：${stats.unreadTotal}`,
        `重要：${stats.counts.important} / 未读 ${stats.unreadCounts.important}`,
        `次重要：${stats.counts.secondary} / 未读 ${stats.unreadCounts.secondary}`,
        `不用管：${stats.counts.ignore} / 未读 ${stats.unreadCounts.ignore}`
      ].join("\n"),
      data: stats
    };
  }

  private toolMarkPanelRead(call: QqAgentToolCall, args: Record<string, unknown>, session: AgentSession): ToolResult {
    const email = this.emailFromArgs(args, session);
    if (!email) return { name: call.name, ok: false, message: "我没找到要标记的邮件。" };
    const panelRead = boolArg(args.panelRead, true);
    const updated = updateProcessedEmailPanelRead(email.id, panelRead);
    return {
      name: call.name,
      ok: true,
      message: `已将《${safeSubject(updated)}》标记为${panelRead ? "系统已读" : "系统未读"}。`,
      emailRefs: [{ index: 1, id: updated.id, subject: safeSubject(updated) }],
      data: { emailId: updated.id, panelRead }
    };
  }

  private toolMarkCategoryRead(call: QqAgentToolCall, args: Record<string, unknown>): ToolResult {
    const category = parseCategory(args.category);
    if (!category) return { name: call.name, ok: false, message: "请指定要标记的分类：重要、次重要或不用管。" };
    const result = markProcessedEmailsPanelRead({ category, mailboxId: text(args.mailboxId) });
    return {
      name: call.name,
      ok: true,
      message: `已将 ${formatMailboxName(text(args.mailboxId))} 的“${categoryLabels[category]}”邮件标记为系统已读：${result.updatedCount} 封。`,
      data: result
    };
  }

  private toolMarkMailboxRead(call: QqAgentToolCall, args: Record<string, unknown>): ToolResult {
    const mailbox = this.mailboxFromArgs(args);
    if (!mailbox) return { name: call.name, ok: false, message: "请指定一个邮箱。" };
    const result = markProcessedEmailsPanelRead({ mailboxId: mailbox.id });
    return {
      name: call.name,
      ok: true,
      message: `已将 ${mailbox.name} 的全部邮件标记为系统已读：${result.updatedCount} 封。`,
      data: result
    };
  }

  private async toolReclassify(call: QqAgentToolCall, args: Record<string, unknown>, session: AgentSession): Promise<ToolResult> {
    const email = this.emailFromArgs(args, session);
    if (!email) return { name: call.name, ok: false, message: "我没找到要重新分类的邮件。" };
    const settings = readSettings().ai;
    if (!settings.apiKey.trim()) return { name: call.name, ok: false, message: "AI API Key 未配置，无法重新分类。" };
    const result = await this.classify({
      mailboxId: email.mailboxId,
      externalUid: email.externalUid,
      messageId: email.messageId,
      subject: email.subject,
      fromName: email.fromName,
      fromAddress: email.fromAddress,
      toText: email.toText,
      receivedAt: email.receivedAt,
      originalText: email.originalText,
      rawSource: email.rawSource,
      attachments: email.attachments
    }, settings, { timeoutMs: 45000 });
    const updated = updateProcessedEmailClassification(email.id, result);
    return {
      name: call.name,
      ok: true,
      message: `已重新分类《${safeSubject(updated)}》：${categoryLabels[updated.category]}\n摘要：${truncate(updated.summaryZh, 160)}`,
      emailRefs: [{ index: 1, id: updated.id, subject: safeSubject(updated) }],
      data: { emailId: updated.id, category: updated.category }
    };
  }

  private toolMoveCategory(call: QqAgentToolCall, args: Record<string, unknown>, session: AgentSession): ToolResult {
    const email = this.emailFromArgs(args, session);
    const category = parseCategory(args.category);
    if (!email) return { name: call.name, ok: false, message: "我没找到要改分类的邮件。" };
    if (!category) return { name: call.name, ok: false, message: "请指定目标分类：重要、次重要或不用管。" };
    const updated = updateProcessedEmailCategory(email.id, category);
    return {
      name: call.name,
      ok: true,
      message: `已将《${safeSubject(updated)}》改为“${categoryLabels[category]}”。`,
      emailRefs: [{ index: 1, id: updated.id, subject: safeSubject(updated) }],
      data: { emailId: updated.id, category }
    };
  }

  private toolMailboxList(call: QqAgentToolCall): ToolResult {
    const mailboxes = readMailboxes();
    if (!mailboxes.length) return { name: call.name, ok: true, message: "还没有配置邮箱。" };
    return {
      name: call.name,
      ok: true,
      message: "邮箱列表：\n" + mailboxes.map((mailbox, index) => {
        const state = mailbox.enabled ? "启用" : "停用";
        const sync = mailbox.lastSyncAt ? ` · 上次同步 ${formatAt(mailbox.lastSyncAt)}` : "";
        const error = mailbox.lastError ? `\n   错误：${truncate(mailbox.lastError, 90)}` : "";
        return `${index + 1}. ${mailbox.name} <${mailbox.email}> · ${mailbox.protocol.toUpperCase()} · ${state}${sync}${error}`;
      }).join("\n"),
      data: { count: mailboxes.length }
    };
  }

  private async toolMailboxHealth(call: QqAgentToolCall, args: Record<string, unknown>): Promise<ToolResult> {
    const requested = this.mailboxFromArgs(args);
    const targets = requested ? [requested] : readMailboxes().filter((mailbox) => mailbox.enabled).slice(0, 5);
    if (!targets.length) return { name: call.name, ok: true, message: "没有可检查的启用邮箱。" };
    const lines: string[] = [];
    for (const mailbox of targets) {
      try {
        const count = mailbox.protocol === "imap"
          ? await withTimeout(this.countUnreadImap(mailbox, 1), 30000, "IMAP 连接检查超时")
          : await withTimeout(this.countUnreadPop3(mailbox, 1), 30000, "POP3 连接检查超时");
        lines.push(`${mailbox.name}：可连接，待处理邮件 ${count} 封以内。`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        lines.push(`${mailbox.name}：连接失败，${truncate(message, 90)}`);
      }
    }
    return { name: call.name, ok: true, message: "邮箱健康检查：\n" + lines.join("\n") };
  }

  private toolNotificationFailed(call: QqAgentToolCall, limit: number, offset: number): ToolResult {
    const result = queryNotificationDeliveries({ channel: "qq", status: "failed", offset, limit });
    const message = formatNotifications("QQ 通知失败队列：", result.items, offset);
    return {
      name: call.name,
      ok: true,
      message: result.hasMoreAfter ? `${message}\n\n回复“继续”查看更多。` : message,
      notificationRefs: notificationRefs(result.items, offset),
      nextPageTool: result.hasMoreAfter ? { toolCall: { ...call, arguments: { ...(call.arguments ?? {}), offset: offset + result.items.length } }, nextOffset: offset + result.items.length } : undefined,
      data: { total: result.total }
    };
  }

  private toolNotificationRetryOne(call: QqAgentToolCall, args: Record<string, unknown>, session: AgentSession): ToolResult {
    const deliveryId = text(args.deliveryId) ?? this.notificationRefFromArgs(args, session)?.id;
    if (!deliveryId) return { name: call.name, ok: false, message: "我没找到要重试的通知记录。" };
    const delivery = retryNotificationDelivery(deliveryId);
    if (!delivery) return { name: call.name, ok: false, message: "通知记录不存在。" };
    void import("../notifications/dispatcher").then(({ scheduleNotificationDispatch }) => scheduleNotificationDispatch(0));
    return { name: call.name, ok: true, message: "已加入 QQ 通知重试队列。", data: delivery };
  }

  private toolNotificationRetryAll(call: QqAgentToolCall): ToolResult {
    const updatedCount = retryNotificationDeliveriesByChannel("qq");
    if (updatedCount > 0) {
      void import("../notifications/dispatcher").then(({ scheduleNotificationDispatch }) => scheduleNotificationDispatch(0));
    }
    return { name: call.name, ok: true, message: `已重试全部失败/暂停 QQ 通知：${updatedCount} 条。`, data: { updatedCount } };
  }

  private toolNotificationPauseOne(call: QqAgentToolCall, args: Record<string, unknown>, session: AgentSession): ToolResult {
    const deliveryId = text(args.deliveryId) ?? this.notificationRefFromArgs(args, session)?.id;
    if (!deliveryId) return { name: call.name, ok: false, message: "我没找到要暂停的通知记录。" };
    const delivery = pauseNotificationDelivery(deliveryId);
    if (!delivery) return { name: call.name, ok: false, message: "通知记录不存在。" };
    return { name: call.name, ok: true, message: "已暂停这条 QQ 通知。", data: delivery };
  }

  private toolNotificationResumeOne(call: QqAgentToolCall, args: Record<string, unknown>, session: AgentSession): ToolResult {
    const deliveryId = text(args.deliveryId) ?? this.notificationRefFromArgs(args, session)?.id;
    if (!deliveryId) return { name: call.name, ok: false, message: "我没找到要恢复的通知记录。" };
    const delivery = resumeNotificationDelivery(deliveryId);
    if (!delivery) return { name: call.name, ok: false, message: "通知记录不存在。" };
    void import("../notifications/dispatcher").then(({ scheduleNotificationDispatch }) => scheduleNotificationDispatch(0));
    return { name: call.name, ok: true, message: "已恢复这条 QQ 通知并加入重试队列。", data: delivery };
  }

  private async toolProcessStatus(call: QqAgentToolCall): Promise<ToolResult> {
    const { isProcessorRunning } = await import("../email/processor");
    const running = isProcessorRunning();
    const lastRun = readProcessingRuns(1)[0];
    return { name: call.name, ok: true, message: summarizeRun(lastRun, running), data: { running, lastRun } };
  }

  private async toolRunAll(call: QqAgentToolCall, userOpenId: string): Promise<ToolResult> {
    this.startProcessing(undefined, userOpenId, "全部邮箱");
    return { name: call.name, ok: true, message: "已开始处理全部已启用邮箱。完成后我会再发一条结果。" };
  }

  private async toolRunMailbox(call: QqAgentToolCall, args: Record<string, unknown>, userOpenId: string): Promise<ToolResult> {
    const mailbox = this.mailboxFromArgs(args);
    if (!mailbox) return { name: call.name, ok: false, message: "请指定要处理的邮箱。" };
    this.startProcessing(mailbox.id, userOpenId, mailbox.name);
    return { name: call.name, ok: true, message: `已开始处理 ${mailbox.name}。完成后我会再发一条结果。` };
  }

  private startProcessing(mailboxId: string | undefined, userOpenId: string, label: string) {
    void import("../email/processor")
      .then(({ processMailboxes }) => processMailboxes(mailboxId ? { mailboxId } : {}))
      .then((run) => {
        const message = [
          `${label} 处理完成：${run.status === "success" ? "成功" : "有错误"}`,
          `处理 ${run.processedCount} 封，重要 ${run.importantCount}，次重要 ${run.secondaryCount}，不用管 ${run.ignoreCount}`,
          run.errors.length ? `错误：${truncate(run.errors[run.errors.length - 1] || "", 140)}` : ""
        ].filter(Boolean).join("\n");
        return this.sendReply(userOpenId, message);
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        return this.sendReply(userOpenId, `${label} 处理启动失败：${truncate(message, 140)}`);
      });
  }

  private emailRefFromArgs(args: Record<string, unknown>, session: AgentSession) {
    const index = intArg(args.index, 0);
    return session.lastEmails.find((item) => item.index === index)
      ?? (index > 0 ? session.lastEmails[index - 1] : undefined);
  }

  private emailFromArgs(args: Record<string, unknown>, session: AgentSession) {
    const emailId = text(args.emailId) ?? this.emailRefFromArgs(args, session)?.id;
    return emailId ? getProcessedEmailById(emailId) : undefined;
  }

  private notificationRefFromArgs(args: Record<string, unknown>, session: AgentSession) {
    const index = intArg(args.index, 0);
    return session.lastNotifications.find((item) => item.index === index)
      ?? (index > 0 ? session.lastNotifications[index - 1] : undefined);
  }

  private mailboxFromArgs(args: Record<string, unknown>) {
    const mailboxId = text(args.mailboxId);
    const mailboxName = text(args.mailboxName) ?? text(args.name);
    const mailboxes = readMailboxes();
    if (mailboxId) return mailboxes.find((mailbox) => mailbox.id === mailboxId || mailbox.email === mailboxId);
    if (!mailboxName) return undefined;
    const normalized = mailboxName.toLowerCase();
    return mailboxes.find((mailbox) =>
      mailbox.name.toLowerCase() === normalized ||
      mailbox.email.toLowerCase() === normalized ||
      mailbox.name.toLowerCase().includes(normalized) ||
      mailbox.email.toLowerCase().includes(normalized)
    );
  }

  private readSession(userOpenId: string, agent: QqAgentSettings): AgentSession {
    const saved = readQqState<Partial<AgentSession>>(sessionKey(userOpenId));
    const expired = saved?.updatedAt && Date.parse(saved.updatedAt) + SESSION_TTL_MS < this.now();
    const session: AgentSession = !saved || expired
      ? {
          userOpenId,
          history: [],
          lastEmails: [],
          lastNotifications: [],
          updatedAt: new Date(this.now()).toISOString()
        }
      : {
          userOpenId,
          history: Array.isArray(saved.history) ? saved.history.slice(-agent.maxResults * 2) as AgentSession["history"] : [],
          lastEmails: Array.isArray(saved.lastEmails) ? saved.lastEmails.slice(0, 20) as AgentEmailRef[] : [],
          lastNotifications: Array.isArray(saved.lastNotifications) ? saved.lastNotifications.slice(0, 20) as AgentNotificationRef[] : [],
          lastList: saved.lastList,
          pendingAction: saved.pendingAction,
          updatedAt: saved.updatedAt ?? new Date(this.now()).toISOString()
        };
    return session;
  }

  private saveSession(session: AgentSession, agent: QqAgentSettings) {
    session.updatedAt = new Date(this.now()).toISOString();
    session.history = session.history.slice(-Math.max(2, agent.maxResults * 2));
    session.lastEmails = session.lastEmails.slice(0, 20);
    session.lastNotifications = session.lastNotifications.slice(0, 20);
    updateQqState(sessionKey(session.userOpenId), session);
  }

  private appendHistory(session: AgentSession, role: "user" | "assistant", content: string, agent: QqAgentSettings) {
    session.history.push({ role, content: truncate(content, 600), at: new Date(this.now()).toISOString() });
    session.history = session.history.slice(-Math.max(2, agent.maxResults * 2));
  }

  private async sendReply(userOpenId: string, content: string, msgId?: string) {
    const chunks = this.splitReply(content);
    for (const [index, chunk] of chunks.entries()) {
      await this.client.sendDirectMessage({
        userOpenId,
        content: chunk,
        ...(index === 0 && msgId ? { msgId } : {})
      });
    }
  }

  private splitReply(content: string) {
    const normalized = content.replace(/\n{3,}/g, "\n\n").trim() || "我没有生成有效回复。";
    if (normalized.length <= MAX_QQ_MESSAGE_CHARS) return [normalized];
    const chunks: string[] = [];
    let rest = normalized;
    while (rest.length > MAX_QQ_MESSAGE_CHARS) {
      let cut = rest.lastIndexOf("\n", MAX_QQ_MESSAGE_CHARS);
      if (cut < 400) cut = MAX_QQ_MESSAGE_CHARS;
      chunks.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) chunks.push(rest);
    return chunks;
  }
}

export function createQqAgentService(dependencies: QqAgentServiceDependencies) {
  return new QqAgentService(dependencies);
}
