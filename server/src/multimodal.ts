import type { AiSettings, EmailAttachment, IncomingEmail, MailCategory, MultimodalAnalysis } from "./types";

const categoryValues = new Set<MailCategory>(["important", "secondary", "ignore"]);

type MultimodalContent =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file_url"; file_url: { url: string } };

function extractJson(text: string) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]?.trim().startsWith("{")) return fenced[1].trim();
  return trimmed.match(/\{[\s\S]*\}/)?.[0] ?? "";
}

function normalizeCategory(value: unknown): MailCategory | undefined {
  return typeof value === "string" && categoryValues.has(value as MailCategory)
    ? (value as MailCategory)
    : undefined;
}

function supportedAttachments(email: IncomingEmail, settings: AiSettings) {
  const perFileBytes = Math.max(settings.multimodalMaxAttachmentMb || 8, 1) * 1024 * 1024;
  const totalBytes = Math.max(settings.multimodalMaxTotalMb || 18, 1) * 1024 * 1024;
  let usedBytes = 0;
  const selected: EmailAttachment[] = [];
  const skipped: EmailAttachment[] = [];

  for (const attachment of email.attachments ?? []) {
    if (!attachment.supportedForVision || !attachment.contentBase64) continue;
    if (attachment.size > perFileBytes || usedBytes + attachment.size > totalBytes) {
      skipped.push(attachment);
      continue;
    }
    selected.push(attachment);
    usedBytes += attachment.size;
  }

  return { selected, skipped };
}

function attachmentLabel(attachment: EmailAttachment) {
  const sizeKb = Math.max(1, Math.round(attachment.size / 1024));
  return `${attachment.filename} (${attachment.contentType}, ${sizeKb} KB)`;
}

function buildPrompt(email: IncomingEmail, attachments: EmailAttachment[]) {
  const attachmentList = attachments.map((attachment, index) => `${index + 1}. ${attachmentLabel(attachment)}`).join("\n");

  return [
    "你是自动邮件系统的多模态邮件分析器。请阅读邮件正文、内嵌图片和 PDF/图片附件，找出正文里可能没有出现的关键信息。",
    "只输出严格 JSON，不要 Markdown，不要解释。",
    "JSON 字段必须是：summaryZh, reasonZh, categoryHint, importantSignalsZh。",
    "categoryHint 只能是 important、secondary、ignore。",
    "分类标准：需要用户立即处理、回复、确认、安全处理、付款、合同、学校/老师/课程/作业/成绩/考勤/会议等个人事项，倾向 important。",
    "需要用户了解、留档、稍后阅读、账单/扣款/收据/订单/物流/预约状态等，倾向 secondary。",
    "纯促销、折扣、品牌营销、招生广告、newsletter、新闻摘要、open house、gift card、visit campus，且没有个人账户或明确待办信息，倾向 ignore。",
    "如果图片或 PDF 中出现正文没有的截止时间、金额、账号风险、老师/学校要求、待办事项，请写入 importantSignalsZh。",
    "",
    `主题：${email.subject || "(无主题)"}`,
    `发件人：${email.fromName || ""} <${email.fromAddress || ""}>`,
    `收件人：${email.toText || ""}`,
    `时间：${email.receivedAt || ""}`,
    "",
    "邮件正文摘录：",
    (email.originalText || "").slice(0, 6000) || "(正文为空，请重点看附件/内嵌图片)",
    "",
    "需要识别的附件/内嵌图片：",
    attachmentList
  ].join("\n");
}

function attachmentToContent(attachment: EmailAttachment): MultimodalContent | undefined {
  if (!attachment.contentBase64) return undefined;
  const url = `data:${attachment.contentType};base64,${attachment.contentBase64}`;
  if (/^image\//i.test(attachment.contentType)) {
    return { type: "image_url", image_url: { url } };
  }
  if (/^application\/pdf$/i.test(attachment.contentType)) {
    return { type: "file_url", file_url: { url } };
  }
  return undefined;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("多模态识别请求超时，请检查 GLM-5V-Turbo Base URL、网络或附件大小。");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeAnalysis(
  value: unknown,
  model: string,
  selected: EmailAttachment[],
  skipped: EmailAttachment[]
): MultimodalAnalysis {
  const item = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const signals = Array.isArray(item.importantSignalsZh)
    ? item.importantSignalsZh.filter((entry): entry is string => typeof entry === "string").slice(0, 8)
    : [];

  return {
    model,
    summaryZh: typeof item.summaryZh === "string" ? item.summaryZh.slice(0, 1200) : "多模态模型未返回清晰摘要。",
    reasonZh: typeof item.reasonZh === "string" ? item.reasonZh.slice(0, 800) : "多模态模型未返回清晰理由。",
    categoryHint: normalizeCategory(item.categoryHint),
    importantSignalsZh: signals,
    analyzedAt: new Date().toISOString(),
    attachmentCount: selected.length,
    analyzedAttachmentNames: selected.map((attachment) => attachment.filename),
    skippedAttachmentNames: skipped.map((attachment) => attachment.filename)
  };
}

export function hasMultimodalWork(email: IncomingEmail, settings: AiSettings) {
  if (!settings.multimodalEnabled) return false;
  return Boolean(email.attachments?.some((attachment) => attachment.supportedForVision && attachment.contentBase64));
}

export function stripAttachmentContent(email: IncomingEmail): IncomingEmail {
  if (!email.attachments?.length) return email;
  return {
    ...email,
    attachments: email.attachments.map(({ contentBase64: _contentBase64, ...attachment }) => attachment)
  };
}

export function withMultimodalContext(email: IncomingEmail, analysis?: MultimodalAnalysis): IncomingEmail {
  if (!analysis) return email;
  const signals = analysis.importantSignalsZh.length
    ? analysis.importantSignalsZh.map((signal, index) => `${index + 1}. ${signal}`).join("\n")
    : "无明确附件关键信号。";
  const context = [
    "",
    "【内嵌图片/PDF 多模态识别结果】",
    `模型：${analysis.model}`,
    `分类倾向：${analysis.categoryHint || "未明确"}`,
    `附件概况：${analysis.summaryZh}`,
    `识别理由：${analysis.reasonZh}`,
    "关键信号：",
    signals
  ].join("\n");

  return {
    ...email,
    originalText: `${email.originalText || ""}${context}`,
    multimodalAnalysis: analysis
  };
}

export async function analyzeEmailAttachments(
  email: IncomingEmail,
  settings: AiSettings,
  options: { timeoutMs?: number } = {}
): Promise<MultimodalAnalysis | undefined> {
  if (!settings.multimodalEnabled) return undefined;
  if (!settings.apiKey.trim()) {
    throw new Error("多模态识别需要 AI API Key，请先在管理设置中配置。");
  }

  const { selected, skipped } = supportedAttachments(email, settings);
  if (!selected.length) {
    const skippedNames = skipped.map((attachment) => attachmentLabel(attachment)).join("、");
    throw new Error(`邮件包含图片/PDF，但全部超过多模态大小上限：${skippedNames || "未知附件"}`);
  }

  const content: MultimodalContent[] = [];
  for (const attachment of selected) {
    const item = attachmentToContent(attachment);
    if (item) content.push(item);
  }
  content.push({ type: "text", text: buildPrompt(email, selected) });

  const response = await fetchWithTimeout(settings.multimodalBaseUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${settings.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: settings.multimodalModel,
      temperature: Math.min(settings.temperature ?? 0.1, 0.3),
      messages: [
        {
          role: "user",
          content
        }
      ]
    })
  }, options.timeoutMs ?? 90000);

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`GLM-5V-Turbo 多模态识别失败 ${response.status}: ${detail.slice(0, 300)}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
  };
  const rawContent = payload.choices?.[0]?.message?.content;
  const text = typeof rawContent === "string"
    ? rawContent
    : Array.isArray(rawContent)
      ? rawContent.map((item) => item.text ?? "").join("\n")
      : "";
  const jsonText = extractJson(text);
  if (!jsonText) {
    throw new Error(`GLM-5V-Turbo 多模态返回内容不是 JSON: ${text.slice(0, 160) || "空响应"}`);
  }

  return normalizeAnalysis(JSON.parse(jsonText), settings.multimodalModel, selected, skipped);
}
