import type { AiSettings, ClassificationResult, IncomingEmail, MailCategory } from "./types";

const categoryValues = new Set<MailCategory>(["important", "secondary", "ignore"]);

const systemPrompt =
  [
    "你是一个可靠的中文邮件助理。请只根据邮件内容和以下分类准则判断重要程度，并输出严格 JSON。",
    "分类只能是 important、secondary、ignore。",
    "第一原则：只要这封邮件需要用户看、确认、留意、稍后阅读或留档，就不能归为 ignore，必须在 important 或 secondary 中选择。",
    "important：需要用户处理、回复、付款、确认、安全风险、合同、老师/学校直接联系、课程作业、成绩、考勤、会议或明确截止时间。",
    "只有真正来自老师、advisor、counselor、faculty、principal、dean、教务等，并且和用户本人学校事务有关的邮件，才归为 important。",
    "secondary：需要用户看但无需立刻行动，或值得留档、稍后阅读、了解状态的邮件，例如付款成功回执、扣款确认、AutoPay confirmation、收据、账单记录、订单确认、订阅续费确认、账户通知、物流/预约/报名状态、非紧急学校信息等。",
    "ignore：只有完全不需要用户看的邮件才归为 ignore，例如普通推广邮件、招生广告、教育机构推广、私校广告、college search、open house、gift card、visit campus、普通 newsletter、news、digest、新闻摘要、品牌宣传、活动宣传、促销折扣、sale、discount、coupon、% off、flash sale。",
    "不要因为促销邮件里出现 limited time、today、tomorrow、order、subscription、confirmation、shop、campus 等普通营销词就归为 secondary 或 important。",
    "如果邮件虽然看起来像通知或 newsletter，但包含用户个人账户、学校、课程、付款、预约、物流、身份、安全、截止时间或需要了解的具体信息，应归为 secondary 或 important，而不是 ignore。",
    "不要输出规则命中、关键词命中或系统后处理的说法；你自己给出最终分类理由。"
  ].join(" ");

function compactEmail(email: IncomingEmail) {
  const body = email.originalText || email.rawSource || "";
  return [
    `主题: ${email.subject || "(无主题)"}`,
    `发件人: ${email.fromName || ""} <${email.fromAddress || ""}>`,
    `收件人: ${email.toText || ""}`,
    `时间: ${email.receivedAt || ""}`,
    "",
    body.slice(0, 12000)
  ].join("\n");
}

function userPrompt(email: IncomingEmail) {
  return [
    "请用中文整理并分类这封邮件。",
    "只输出一个 JSON 对象，不要 Markdown，不要解释。",
    "JSON 字段必须是：category, summaryZh, reasonZh, actionItemsZh。",
    "先判断用户是否需要看这封邮件。只要需要看、需要留意、需要稍后阅读或需要留档，就不能标为 ignore。",
    "注意：老师、advisor、counselor、faculty、principal、dean、教务等发来的，并且涉及课程、作业、成绩、考勤、会议、提交、确认、回复等用户本人学校事务的邮件，必须标为 important。",
    "注意：普通推广、招生广告、教育机构广告、私校推广、college search、open house、gift card、visit campus、普通 newsletter、news、digest、新闻摘要、品牌宣传、活动宣传、促销折扣，且没有用户需要看的个人信息时，标为 ignore。",
    "注意：付款成功、扣款确认、AutoPay confirmation、收据、账单记录、订单确认等财务留档邮件，即使不需要操作，也必须标为 secondary，不能标为 ignore。",
    "注意：普通且非个人化的促销折扣、sale、discount、coupon、% off、flash sale、品牌营销邮件应归为 ignore；不要因为正文或页脚出现 order、subscription、confirmation、today、tomorrow、limited time 就升为 secondary。",
    "注意：如果邮件包含用户个人账户、学校、课程、付款、预约、物流、身份、安全、截止时间或需要了解的具体信息，但无需马上行动，应标为 secondary。",
    "最终分类由你根据提示词直接决定，后端不会再用关键词规则替你改分类，所以请谨慎区分促销邮件和真实付款/订单/账单记录。",
    "",
    compactEmail(email)
  ].join("\n");
}

function extractJson(text: string) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]?.trim().startsWith("{")) return fenced[1].trim();

  const match = trimmed.match(/\{[\s\S]*\}/);
  return match?.[0] ?? "";
}

function normalizeCategory(value: unknown): MailCategory {
  if (typeof value === "string" && categoryValues.has(value as MailCategory)) {
    return value as MailCategory;
  }
  return "secondary";
}

function normalizeResult(value: unknown): ClassificationResult {
  const item = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const actionItems = Array.isArray(item.actionItemsZh)
    ? item.actionItemsZh.filter((entry): entry is string => typeof entry === "string").slice(0, 6)
    : [];

  return {
    category: normalizeCategory(item.category),
    summaryZh: typeof item.summaryZh === "string" ? item.summaryZh.slice(0, 800) : "未能生成中文概况。",
    reasonZh: typeof item.reasonZh === "string" ? item.reasonZh.slice(0, 500) : "AI 未返回明确理由。",
    actionItemsZh: actionItems
  };
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("AI 请求超时，请检查 Base URL、网络或模型名称。");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function isAnthropicEndpoint(baseUrl: string) {
  return /\/anthropic(?:\/|$)/i.test(baseUrl) || /\/v1\/messages$/i.test(baseUrl);
}

function resolveOpenAiChatUrl(baseUrl: string) {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(normalized)) return normalized;
  return `${normalized}/chat/completions`;
}

function resolveAnthropicMessagesUrl(baseUrl: string) {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (/\/v1\/messages$/i.test(normalized)) return normalized;
  if (/\/v1$/i.test(normalized)) return `${normalized}/messages`;
  return `${normalized}/v1/messages`;
}

async function requestOpenAiCompatible(
  email: IncomingEmail,
  settings: AiSettings,
  timeoutMs: number
) {
  const response = await fetchWithTimeout(resolveOpenAiChatUrl(settings.baseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${settings.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: settings.model,
      temperature: settings.temperature,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt(email) }
      ]
    })
  }, timeoutMs);

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`AI 请求失败 ${response.status}: ${detail.slice(0, 300)}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((item) => item.text ?? "").join("\n");
  return "";
}

async function requestAnthropicCompatible(
  email: IncomingEmail,
  settings: AiSettings,
  timeoutMs: number
) {
  const response = await fetchWithTimeout(resolveAnthropicMessagesUrl(settings.baseUrl), {
    method: "POST",
    headers: {
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: settings.model,
      max_tokens: 1200,
      temperature: settings.temperature,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: userPrompt(email)
        }
      ]
    })
  }, timeoutMs);

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`AI 请求失败 ${response.status}: ${detail.slice(0, 300)}`);
  }

  const payload = (await response.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  return payload.content?.map((item) => item.text ?? "").join("\n") ?? "";
}

export async function classifyEmail(
  email: IncomingEmail,
  settings: AiSettings,
  options: { timeoutMs?: number } = {}
): Promise<ClassificationResult> {
  if (!settings.apiKey.trim()) {
    throw new Error("AI API Key 未配置，无法进行 AI 分类。");
  }

  const timeoutMs = options.timeoutMs ?? 90000;
  const content = isAnthropicEndpoint(settings.baseUrl)
    ? await requestAnthropicCompatible(email, settings, timeoutMs)
    : await requestOpenAiCompatible(email, settings, timeoutMs);

  const jsonText = extractJson(content);
  if (!jsonText) {
    throw new Error(`AI 返回内容不是 JSON: ${content.slice(0, 160) || "空响应"}`);
  }

  return normalizeResult(JSON.parse(jsonText));
}
