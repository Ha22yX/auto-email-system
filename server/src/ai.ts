import type { AiSettings, ClassificationResult, IncomingEmail, MailCategory } from "./types";

const categoryValues = new Set<MailCategory>(["important", "secondary", "ignore"]);

const systemPrompt =
  "你是一个可靠的中文邮件助理。请判断邮件重要程度并输出严格 JSON。分类只能是 important、secondary、ignore。important 表示需要用户处理、回复、付款、确认、安全风险、合同、老师/学校联系、课程作业、成绩、考勤、会议或明确截止时间。只有真正来自老师、advisor、counselor、faculty、principal、dean、教务等，并且和用户本人学校事务有关的邮件，才归为 important。任何推广邮件、招生广告、教育机构推广、私校广告、college search、open house、gift card、visit campus、newsletter、news、digest、新闻摘要、品牌宣传、活动宣传、促销折扣都必须归为 ignore，不要因为包含 school、college、education 或截止时间就标 important。secondary 表示值得阅读但无需立刻行动，付款成功回执、扣款确认、AutoPay confirmation、收据、账单记录、订单确认、订阅续费确认等财务记录至少必须归为 secondary，不能归为 ignore。";

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
    "注意：老师、advisor、counselor、faculty、principal、dean、教务等发来的，并且涉及课程、作业、成绩、考勤、会议、提交、确认、回复等用户本人学校事务的邮件，必须标为 important。",
    "注意：任何推广、招生广告、教育机构广告、私校推广、college search、open house、gift card、visit campus、newsletter、news、digest、新闻摘要、品牌宣传、活动宣传、促销折扣，都必须标为 ignore，不要因为有截止时间或 school/college/education 字样就标为 important。",
    "注意：付款成功、扣款确认、AutoPay confirmation、收据、账单记录、订单确认等财务留档邮件，即使不需要操作，也必须标为 secondary，不能标为 ignore。",
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

function includesAny(text: string, words: string[]) {
  return words.some((word) => text.includes(word));
}

function emailText(email: IncomingEmail) {
  return [
    email.subject,
    email.fromName,
    email.fromAddress,
    email.toText,
    email.originalText,
    email.rawSource
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

function isFinancialRecordEmail(email: IncomingEmail) {
  const text = emailText(email);
  const financialTerms = [
    "payment",
    "autopay",
    "auto pay",
    "billing",
    "bill",
    "invoice",
    "receipt",
    "charge",
    "charged",
    "paid",
    "transaction",
    "statement",
    "order",
    "subscription",
    "renewal",
    "credit card",
    "card ending",
    "付款",
    "支付",
    "扣款",
    "自动付款",
    "自动扣款",
    "账单",
    "发票",
    "收据",
    "回执",
    "交易",
    "订单",
    "续费",
    "信用卡"
  ];
  const recordTerms = [
    "confirmation",
    "confirmed",
    "receipt",
    "successful",
    "succeeded",
    "processed",
    "paid",
    "charged",
    "autopay confirmation",
    "payment confirmation",
    "payment received",
    "order confirmation",
    "transaction receipt",
    "确认",
    "成功",
    "已付款",
    "已支付",
    "已扣款",
    "扣款成功",
    "支付成功",
    "付款成功",
    "成功扣除",
    "回执",
    "收据",
    "凭证",
    "订单确认"
  ];

  return includesAny(text, financialTerms) && includesAny(text, recordTerms);
}

function isSchoolPriorityEmail(email: IncomingEmail) {
  const text = emailText(email);
  const from = `${email.fromName || ""} ${email.fromAddress || ""}`.toLowerCase();
  const to = `${email.toText || ""}`.toLowerCase();
  const senderIsKnownSchool = from.includes("@whschool.org") || from.includes("wardlaw-hartridge");
  const messageIsForSchoolMailbox = to.includes("@whschool.org");
  const directSchoolSenderTerms = [
    "teacher",
    "advisor",
    "adviser",
    "counselor",
    "faculty",
    "principal",
    "dean",
    "registrar",
    "老师",
    "班主任",
    "辅导员",
    "教务",
    "校长"
  ];
  const schoolContextTerms = [
    "class",
    "course",
    "assignment",
    "homework",
    "grade",
    "attendance",
    "absence",
    "exam",
    "quiz",
    "schedule",
    "conference",
    "meeting",
    "permission slip",
    "field trip",
    "老师",
    "课程",
    "班级",
    "作业",
    "成绩",
    "考勤",
    "缺勤",
    "考试",
    "测验",
    "会议",
    "家长会"
  ];
  const directActionTerms = [
    "reply",
    "respond",
    "action required",
    "deadline",
    "due",
    "tomorrow",
    "today",
    "confirm",
    "sign",
    "submit",
    "register",
    "please",
    "schedule",
    "meeting",
    "conference",
    "appointment",
    "required",
    "请回复",
    "需要回复",
    "需要处理",
    "截止",
    "今天",
    "明天",
    "确认",
    "提交",
    "报名",
    "签字",
    "安排",
    "会议",
    "必须"
  ];

  if (isPromotionalOrNewsEmail(email)) return false;
  if (includesAny(from, directSchoolSenderTerms)) return true;
  if (senderIsKnownSchool) return includesAny(text, schoolContextTerms) || includesAny(text, directActionTerms);
  if (!messageIsForSchoolMailbox) return false;
  return includesAny(text, schoolContextTerms) && includesAny(text, directActionTerms);
}

function isPromotionalOrNewsEmail(email: IncomingEmail) {
  const text = emailText(email);
  return includesAny(text, [
    "promotion",
    "promotional",
    "marketing",
    "advertisement",
    "sponsored",
    "sale",
    "discount",
    "deal",
    "offer",
    "coupon",
    "limited time",
    "unsubscribe",
    "newsletter",
    "news",
    "digest",
    "weekly update",
    "daily update",
    "headlines",
    "latest stories",
    "press release",
    "admissions",
    "admission",
    "apply now",
    "college search",
    "open house",
    "visit campus",
    "campus visit",
    "gift card",
    "tuition",
    "financial aid",
    "private education",
    "enroll",
    "enrollment",
    "prospective student",
    "unsubscribe",
    "newsletter",
    "推广",
    "营销",
    "广告",
    "促销",
    "折扣",
    "优惠",
    "限时",
    "退订",
    "新闻",
    "资讯",
    "简报",
    "周报",
    "日报",
    "摘要",
    "头条",
    "品牌宣传",
    "活动宣传",
    "招生",
    "申请入学",
    "校园参观",
    "开放日",
    "教育推广",
    "教育广告",
    "礼品卡"
  ]);
}

function normalizeBusinessRules(email: IncomingEmail, result: ClassificationResult): ClassificationResult {
  if (isPromotionalOrNewsEmail(email) && !isFinancialRecordEmail(email)) {
    return {
      ...result,
      category: "ignore",
      reasonZh: `${result.reasonZh} 这封邮件命中推广、招生、新闻简报或营销规则，系统要求归为不用管。`,
      actionItemsZh: []
    };
  }

  if (result.category !== "important" && isSchoolPriorityEmail(email)) {
    return {
      ...result,
      category: "important",
      reasonZh: `${result.reasonZh} 这封邮件命中学校/老师/课程事务规则，系统要求归为重要，方便优先查看和处理。`,
      actionItemsZh: result.actionItemsZh.length
        ? result.actionItemsZh
        : ["优先打开原件确认是否需要回复、提交材料、参加会议或完成学校相关事项。"]
    };
  }

  if (result.category === "ignore" && isFinancialRecordEmail(email)) {
    return {
      ...result,
      category: "secondary",
      reasonZh: `${result.reasonZh} 这封邮件属于付款、扣款、账单、收据或订单确认类财务留档邮件，系统规则要求至少归为次重要，不能归入不用管。`
    };
  }

  return result;
}

function heuristicClassify(email: IncomingEmail): ClassificationResult {
  const haystack = emailText(email);
  const financialRecordHit = isFinancialRecordEmail(email);
  const promotionalOrNewsHit = isPromotionalOrNewsEmail(email);
  const schoolPriorityHit = isSchoolPriorityEmail(email);
  const importantWords = [
    "contract",
    "urgent",
    "security",
    "verify",
    "deadline",
    "meeting",
    "payment failed",
    "past due",
    "overdue",
    "action required",
    "合同",
    "紧急",
    "验证码",
    "安全",
    "会议",
    "截止",
    "付款失败",
    "支付失败",
    "逾期",
    "需要操作"
  ];
  const ignoreWords = [
    "unsubscribe",
    "promotion",
    "sale",
    "discount",
    "newsletter",
    "admissions",
    "admission",
    "college search",
    "open house",
    "visit campus",
    "gift card",
    "private education",
    "enroll",
    "退订",
    "促销",
    "折扣",
    "广告",
    "招生"
  ];

  const importantHit = importantWords.some((word) => haystack.includes(word));
  const ignoreHit = ignoreWords.some((word) => haystack.includes(word));
  const category: MailCategory =
    promotionalOrNewsHit && !financialRecordHit
      ? "ignore"
      : importantHit || schoolPriorityHit
        ? "important"
        : financialRecordHit
          ? "secondary"
          : ignoreHit
            ? "ignore"
            : "secondary";

  return {
    category,
    summaryZh: `来自 ${email.fromName || email.fromAddress || "未知发件人"} 的邮件，主题为“${email.subject || "无主题"}”。当前未配置可用 AI Key，系统使用规则兜底完成分类。`,
    reasonZh: promotionalOrNewsHit && !financialRecordHit
      ? "邮件命中推广、招生广告、新闻简报或营销类信号，应归为不用管。"
      : schoolPriorityHit
      ? "邮件命中学校/老师/课程事务规则，属于需要优先查看的学校相关邮件。"
      : importantHit
      ? "邮件包含安全、会议、截止时间、失败付款或需要操作等高优先级信号。"
      : financialRecordHit
        ? "邮件属于付款、扣款、收据、账单或订单确认类财务留档邮件，应归为次重要。"
        : ignoreHit
          ? "邮件包含营销、订阅或退订等低优先级信号。"
          : "邮件没有明显紧急信号，但仍可能包含需要稍后查看的信息。",
    actionItemsZh:
      importantHit || schoolPriorityHit ? ["尽快打开原件确认是否需要回复或处理。"] : []
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
    return normalizeBusinessRules(email, heuristicClassify(email));
  }

  const timeoutMs = options.timeoutMs ?? 90000;
  const content = isAnthropicEndpoint(settings.baseUrl)
    ? await requestAnthropicCompatible(email, settings, timeoutMs)
    : await requestOpenAiCompatible(email, settings, timeoutMs);

  const jsonText = extractJson(content);
  if (!jsonText) {
    throw new Error(`AI 返回内容不是 JSON: ${content.slice(0, 160) || "空响应"}`);
  }

  return normalizeBusinessRules(email, normalizeResult(JSON.parse(jsonText)));
}
