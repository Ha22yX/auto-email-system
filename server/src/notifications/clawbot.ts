import type { Mailbox, NotificationSettings, ProcessedEmail } from "../types";
import { defaultWeclawApiUrl, resolveWeclawRecipientId, sendWeclawDirectText } from "../weclaw/manager";

function formatDateTime(value?: string) {
  if (!value) return "未知时间";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function senderName(email: ProcessedEmail) {
  if (email.fromName && email.fromAddress) return `${email.fromName} <${email.fromAddress}>`;
  return email.fromName || email.fromAddress || "未知发件人";
}

function compactText(value: string, maxLength: number) {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function notificationCategoryMeta(category: ProcessedEmail["category"]) {
  if (category === "important") {
    return {
      icon: "🚨",
      label: "重要邮件",
      helper: "需要尽快查看"
    };
  }
  if (category === "secondary") {
    return {
      icon: "📌",
      label: "次重要邮件",
      helper: "建议稍后阅读"
    };
  }
  return {
    icon: "📎",
    label: "不用管邮件",
    helper: "仅作记录"
  };
}

function validateClawbotSettings(settings: NotificationSettings, options: { requireEnabled?: boolean } = {}) {
  if (options.requireEnabled !== false && !settings.enabled) throw new Error("微信通知未开启。");

  const url = new URL(defaultWeclawApiUrl);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("ClawBot API 地址只支持 HTTP/HTTPS。");
  }
  const recipientId = resolveWeclawRecipientId(settings.clawbotRecipientId);
  if (!recipientId) throw new Error("未找到已绑定的微信接收人，请先启动 WeClaw 并扫码登录。");
  return { url, recipientId };
}

export function shouldNotifyEmail(settings: NotificationSettings, email: ProcessedEmail) {
  if (!settings.enabled) return false;
  if (email.notifiedAt) return false;
  return Boolean(settings.notifyCategories?.[email.category]);
}

export function buildImportantEmailMessage(email: ProcessedEmail, mailbox?: Mailbox) {
  const category = notificationCategoryMeta(email.category);
  const actionItems = email.actionItemsZh?.length
    ? email.actionItemsZh.slice(0, 5).map((item, index) => `${index + 1}. ${compactText(item, 80)}`)
    : ["暂无明确动作，请打开面板确认。"];
  const metadata = [
    `发件人：${compactText(senderName(email), 90)}`,
    `邮箱：${mailbox?.name || "未知邮箱"}`,
    email.toText ? `收件人：${compactText(email.toText, 90)}` : "",
    `时间：${formatDateTime(email.receivedAt || email.processedAt)}`
  ].filter(Boolean);

  return [
    `${category.icon} 自动邮件系统`,
    `【${category.label}】${category.helper}`,
    "",
    "主题",
    compactText(email.subject || "无主题", 90),
    "",
    "关键信息",
    metadata.join("\n"),
    "",
    "中文概况",
    compactText(email.summaryZh || "暂无概况。", 220),
    "",
    "建议动作",
    actionItems.join("\n"),
    "",
    "打开面板可查看邮件原文和完整判断。"
  ].join("\n");
}

class ClawbotSendError extends Error {
  constructor(
    message: string,
    readonly statusCode: number
  ) {
    super(message);
  }
}

function explainClawbotFailure(status: number, responseText: string) {
  const body = responseText.trim();
  if (status === 409 && body.includes("missing context_token")) {
    return new ClawbotSendError([
      "微信接收人已经按扫码账号自动绑定，但还没有可用于主动推送的微信会话上下文。",
      "请在手机微信里打开 ClawBot 联系人，先发送任意一条消息给它，等系统记录到会话后再测试通知。之后会自动保存，重启不用重新扫码。"
    ].join(""), 409);
  }
  if (body.includes("ret=-2")) {
    return new ClawbotSendError([
      "微信 iLink 拒绝发送：参数错误 ret=-2。",
      "通常是缺少该扫码用户的 context_token。请先在微信里给 ClawBot 发任意一条消息以激活会话，然后再测试通知。"
    ].join(""), 409);
  }
  return new ClawbotSendError(`ClawBot 返回 ${status}${body ? `：${body.slice(0, 180)}` : ""}`, 502);
}

export async function sendClawbotText(
  settings: NotificationSettings,
  text: string,
  timeoutMs = 15000,
  options: { requireEnabled?: boolean } = {}
) {
  const { recipientId } = validateClawbotSettings(settings, options);

  try {
    return await sendWeclawDirectText(recipientId, text, timeoutMs);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("ClawBot 通知超时，请确认微信通知桥接正在运行。");
    }
    if (error instanceof Error && error.message.includes("missing context_token")) {
      throw explainClawbotFailure(409, "missing context_token");
    }
    if (error instanceof Error && error.message.includes("ret=-2")) {
      throw explainClawbotFailure(500, error.message);
    }
    throw error;
  }
}

export async function sendEmailNotification(
  settings: NotificationSettings,
  email: ProcessedEmail,
  mailbox?: Mailbox
) {
  return sendClawbotText(settings, buildImportantEmailMessage(email, mailbox));
}

export async function sendClawbotTestNotification(settings: NotificationSettings) {
  return sendClawbotText(
    settings,
    [
      "自动邮件系统测试通知",
      "",
      "如果你看到这条消息，说明微信 ClawBot / WeClaw 通知已经连通。",
      `时间：${formatDateTime(new Date().toISOString())}`
    ].join("\n"),
    10000,
    { requireEnabled: false }
  );
}
