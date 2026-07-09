import type { AiSettings, ClassificationResult, IncomingEmail, MailCategory } from "./types";

const categoryValues = new Set<MailCategory>(["important", "secondary", "ignore"]);

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

function extractJson(text: string) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;

  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) return "";
  return match[0];
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

function heuristicClassify(email: IncomingEmail): ClassificationResult {
  const haystack = `${email.subject}\n${email.fromAddress}\n${email.originalText}`.toLowerCase();
  const importantWords = [
    "invoice",
    "payment",
    "contract",
    "urgent",
    "security",
    "verify",
    "deadline",
    "meeting",
    "账单",
    "付款",
    "合同",
    "发票",
    "紧急",
    "验证码",
    "安全",
    "会议",
    "截止"
  ];
  const ignoreWords = [
    "unsubscribe",
    "promotion",
    "sale",
    "discount",
    "newsletter",
    "退订",
    "促销",
    "折扣",
    "广告"
  ];

  const importantHit = importantWords.some((word) => haystack.includes(word));
  const ignoreHit = ignoreWords.some((word) => haystack.includes(word));
  const category: MailCategory = importantHit ? "important" : ignoreHit ? "ignore" : "secondary";

  return {
    category,
    summaryZh: `来自 ${email.fromName || email.fromAddress || "未知发件人"} 的邮件，主题为“${email.subject || "无主题"}”。当前未配置可用 AI Key，系统使用规则兜底完成分类。`,
    reasonZh: importantHit
      ? "邮件包含账单、合同、安全、会议或截止时间等高优先级信号。"
      : ignoreHit
        ? "邮件包含营销、订阅或退订等低优先级信号。"
        : "邮件没有明显紧急信号，但仍可能包含需要稍后查看的信息。",
    actionItemsZh: importantHit ? ["尽快打开原件确认是否需要回复或处理。"] : []
  };
}

export async function classifyEmail(email: IncomingEmail, settings: AiSettings): Promise<ClassificationResult> {
  if (!settings.apiKey.trim()) {
    return heuristicClassify(email);
  }

  const baseUrl = settings.baseUrl.replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/chat/completions`, {
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
        {
          role: "system",
          content:
            "你是一个极其可靠的中文邮件助理。请判断邮件重要程度并输出严格 JSON。分类只能是 important、secondary、ignore。important 表示需要用户处理、回复、付款、确认、安全风险、合同或明确截止时间。secondary 表示值得阅读但无需立刻行动。ignore 表示营销、通知、订阅、社交提醒或明显无需处理。"
        },
        {
          role: "user",
          content: `请用中文整理并分类这封邮件。只输出 JSON，不要 Markdown。字段如下：category, summaryZh, reasonZh, actionItemsZh。\n\n${compactEmail(email)}`
        }
      ]
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`AI 请求失败 ${response.status}: ${detail.slice(0, 300)}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content ?? "";
  const jsonText = extractJson(content);
  if (!jsonText) {
    throw new Error("AI 返回内容不是 JSON");
  }

  return normalizeResult(JSON.parse(jsonText));
}
