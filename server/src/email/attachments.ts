import { simpleParser } from "mailparser";
import type { EmailAttachment, ProcessedEmail } from "../types";

export const MAX_QQ_ATTACHMENT_BYTES = 4 * 1024 * 1024;
export const MAX_ATTACHMENT_TEXT_CHARS = 12_000;

const blockedExtensions = new Set([
  "apk", "app", "bat", "cmd", "com", "cpl", "dll", "dmg", "exe", "hta", "iso", "jar", "js",
  "jse", "lnk", "msi", "msp", "pif", "pkg", "ps1", "reg", "scr", "sh", "vbe", "vbs", "wsf"
]);
const blockedContentTypes = [
  /^application\/x-msdownload$/i,
  /^application\/x-executable$/i,
  /^application\/x-dosexec$/i,
  /^application\/x-sh$/i,
  /^text\/javascript$/i
];
const readableContentTypes = [
  /^text\//i,
  /^application\/(?:json|ld\+json|xml|xhtml\+xml|csv|rtf)$/i,
  /^message\/rfc822$/i
];

export type AgentAttachment = EmailAttachment & {
  index: number;
  safeFilename: string;
  canRead: boolean;
  canAnalyze: boolean;
  canSend: boolean;
  blockedReason?: string;
};

export type ResolvedAgentAttachment = AgentAttachment & {
  content: Buffer;
};

export type AgentAttachmentSelector = {
  attachmentId?: string;
  attachmentIds?: string[];
  attachmentIndex?: number;
  attachmentIndexes?: number[];
  filename?: string;
  filenames?: string[];
  includeInline?: boolean;
  all?: boolean;
};

function extension(filename: string) {
  return filename.toLowerCase().match(/\.([a-z0-9]{1,12})$/)?.[1] ?? "";
}

export function safeAttachmentFilename(value: string) {
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/]+/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
  return cleaned || "attachment.bin";
}

function attachmentBlockedReason(attachment: Pick<EmailAttachment, "filename" | "contentType">) {
  if (blockedExtensions.has(extension(attachment.filename))) return "出于安全策略，禁止导出可执行或脚本附件";
  if (blockedContentTypes.some((pattern) => pattern.test(attachment.contentType))) {
    return "出于安全策略，禁止导出可执行或脚本附件";
  }
  return undefined;
}

function isTextReadable(attachment: Pick<EmailAttachment, "filename" | "contentType">) {
  if (readableContentTypes.some((pattern) => pattern.test(attachment.contentType))) return true;
  return ["csv", "eml", "html", "htm", "ini", "json", "log", "md", "rtf", "text", "txt", "xml", "yaml", "yml"]
    .includes(extension(attachment.filename));
}

function isAiAnalyzable(contentType: string) {
  return /^image\//i.test(contentType) || /^application\/pdf$/i.test(contentType);
}

function withCapabilities(attachment: EmailAttachment, index: number): AgentAttachment {
  const blockedReason = attachmentBlockedReason(attachment);
  return {
    ...attachment,
    index,
    safeFilename: safeAttachmentFilename(attachment.filename),
    canRead: isTextReadable(attachment),
    canAnalyze: isTextReadable(attachment) || isAiAnalyzable(attachment.contentType),
    canSend: !blockedReason && attachment.size > 0 && attachment.size <= MAX_QQ_ATTACHMENT_BYTES,
    blockedReason: blockedReason
      ?? (attachment.size > MAX_QQ_ATTACHMENT_BYTES ? "附件超过 QQ 单次安全上传上限 4 MB" : undefined)
  };
}

export function listAgentAttachments(email: ProcessedEmail, includeInline = false) {
  const attachments = (email.attachments ?? []).filter((attachment) => includeInline || !attachment.related);
  return attachments.map((attachment, index) => withCapabilities(attachment, index + 1));
}

async function parsedAgentAttachments(email: ProcessedEmail, includeInline: boolean): Promise<ResolvedAgentAttachment[]> {
  if (!email.rawSource) throw new Error("这封邮件没有保存原始 MIME 内容，无法读取附件文件。");
  const parsed = await simpleParser(email.rawSource);
  const storedById = new Map((email.attachments ?? []).map((attachment) => [attachment.id, attachment]));
  const resolved = parsed.attachments.flatMap((attachment, rawIndex) => {
    const id = attachment.cid || attachment.contentId || `attachment-${rawIndex + 1}`;
    const stored = storedById.get(id) ?? email.attachments?.[rawIndex];
    const metadata: EmailAttachment = {
      id,
      filename: attachment.filename || stored?.filename || attachment.contentType || `attachment-${rawIndex + 1}`,
      contentType: attachment.contentType || stored?.contentType || "application/octet-stream",
      size: attachment.size ?? attachment.content.length,
      contentId: attachment.cid || attachment.contentId || stored?.contentId,
      disposition: attachment.contentDisposition || stored?.disposition,
      related: Boolean(attachment.related || attachment.contentDisposition === "inline" || attachment.cid || stored?.related),
      supportedForVision: isAiAnalyzable(attachment.contentType || stored?.contentType || "")
    };
    if (!includeInline && metadata.related) return [];
    return [{ metadata, content: attachment.content }];
  });

  return resolved.map(({ metadata, content }, index) => ({
    ...withCapabilities(metadata, index + 1),
    content
  }));
}

export async function resolveAgentAttachments(email: ProcessedEmail, selector: AgentAttachmentSelector) {
  const attachments = await parsedAgentAttachments(email, Boolean(selector.includeInline));
  const requestedIds = [...new Set([selector.attachmentId, ...(selector.attachmentIds ?? [])]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value)))];
  const requestedNames = [...new Set([selector.filename, ...(selector.filenames ?? [])]
    .map((value) => value?.trim().toLowerCase())
    .filter((value): value is string => Boolean(value)))];
  const requestedIndexes = [...new Set([selector.attachmentIndex, ...(selector.attachmentIndexes ?? [])]
    .map((value) => Math.max(0, Math.floor(value ?? 0)))
    .filter((value) => value > 0))];

  if (selector.all) {
    if (!attachments.length) throw new Error("这封邮件没有可发送的附件。");
    return attachments;
  }

  const selected: ResolvedAgentAttachment[] = [];
  const append = (attachment: ResolvedAgentAttachment | undefined) => {
    if (attachment && !selected.some((item) => item.id === attachment.id && item.index === attachment.index)) {
      selected.push(attachment);
    }
  };
  let missingSelector = false;
  for (const id of requestedIds) {
    const attachment = attachments.find((item) => item.id === id);
    if (!attachment) missingSelector = true;
    append(attachment);
  }
  for (const name of requestedNames) {
    const attachment = attachments.find((item) => item.filename.toLowerCase() === name || item.safeFilename.toLowerCase() === name);
    if (!attachment) missingSelector = true;
    append(attachment);
  }
  for (const index of requestedIndexes) {
    const attachment = attachments[index - 1];
    if (!attachment) missingSelector = true;
    append(attachment);
  }

  const hasSelector = requestedIds.length > 0 || requestedNames.length > 0 || requestedIndexes.length > 0;
  if (!hasSelector) append(attachments[0]);
  if (!selected.length || missingSelector) {
    throw new Error("没有找到全部指定附件。请先列出附件，再按序号选择。");
  }
  return selected;
}

export async function resolveAgentAttachment(email: ProcessedEmail, selector: AgentAttachmentSelector) {
  const attachments = await resolveAgentAttachments(email, selector);
  const attachment = attachments[0];
  if (!attachment) throw new Error("没有找到指定附件。请先列出附件，再按序号选择。");
  return attachment;
}

function decodeEntities(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

export function extractAttachmentText(attachment: ResolvedAgentAttachment) {
  if (!attachment.canRead) throw new Error("这个附件不是可安全读取的文本格式，可使用附件摘要或发送原文件。");
  if (attachment.content.length > 2 * 1024 * 1024) throw new Error("文本附件超过 2 MB，已停止展开正文。");
  let value = attachment.content.toString("utf8").replace(/\u0000/g, "");
  if (/html|xhtml/i.test(attachment.contentType) || /\.html?$/i.test(attachment.filename)) {
    value = value
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ");
    value = decodeEntities(value);
  }
  return value.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_ATTACHMENT_TEXT_CHARS);
}
