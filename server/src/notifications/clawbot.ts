import type { Mailbox, NotificationSettings, ProcessedEmail } from "../types";

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
  if (!settings.clawbotApiUrl.trim()) throw new Error("请填写 ClawBot API 地址。");
  if (!settings.clawbotRecipientId.trim()) throw new Error("请填写微信接收人 ID。");

  const url = new URL(settings.clawbotApiUrl);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("ClawBot API 地址只支持 HTTP/HTTPS。");
  }
  return url;
}

export function shouldNotifyEmail(settings: NotificationSettings, email: ProcessedEmail) {
  if (!settings.enabled) return false;
  if (email.notifiedAt) return false;
  if (settings.importantOnly && email.category !== "important") return false;
  return email.category === "important" || email.category === "secondary";
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

export async function sendClawbotText(
  settings: NotificationSettings,
  text: string,
  timeoutMs = 15000,
  options: { requireEnabled?: boolean } = {}
) {
  const url = validateClawbotSettings(settings, options);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        to: settings.clawbotRecipientId,
        text
      }),
      signal: controller.signal
    });
    const responseText = await response.text().catch(() => "");
    if (!response.ok) {
      throw new Error(`ClawBot 返回 ${response.status}${responseText ? `：${responseText.slice(0, 180)}` : ""}`);
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
