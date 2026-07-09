import type { Mailbox, NotificationSettings, ProcessedEmail } from "../types";
import { defaultWeclawApiUrl, resolveWeclawRecipientId } from "../weclaw/manager";

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
  const categoryLabel = email.category === "important" ? "重要" : "次重要";
  const actions = email.actionItemsZh.length
    ? email.actionItemsZh.map((item, index) => `${index + 1}. ${item}`).join("\n")
    : "暂无明确动作，请打开面板确认。";

  return [
    `📬 自动邮件系统：收到${categoryLabel}邮件`,
    "",
    `主题：${email.subject || "无主题"}`,
    `发件人：${senderName(email)}`,
    `邮箱：${mailbox?.name || "未知邮箱"}`,
    `时间：${formatDateTime(email.receivedAt || email.processedAt)}`,
    "",
    `中文概况：${email.summaryZh}`,
    "",
    `建议动作：\n${actions}`
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
  const { url, recipientId } = validateClawbotSettings(settings, options);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        to: recipientId,
        text
      }),
      signal: controller.signal
    });
    const responseText = await response.text().catch(() => "");
    if (!response.ok) {
      throw explainClawbotFailure(response.status, responseText);
    }
    return responseText;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("ClawBot 通知超时，请确认 weclaw start 正在运行。");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
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
