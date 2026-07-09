import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AiSettings,
  AppState,
  Mailbox,
  NotificationSettings,
  ProcessedEmail,
  ProcessingRun,
  SystemSettings
} from "./types";

const DATA_DIR = path.resolve(process.env.DATA_DIR ?? "data");
const DATA_FILE = path.join(DATA_DIR, "app.db.json");
const schoolPriorityReason = "系统规则更新：学校官方、老师或课程事务相关邮件需要优先查看，归为重要。";
const defaultNotifyCategories: Record<"important" | "secondary" | "ignore", boolean> = {
  important: true,
  secondary: false,
  ignore: false
};

const defaultState: AppState = {
  settings: {
    ai: {
      providerName: "智谱 GLM Coding Plan",
      baseUrl: "https://open.bigmodel.cn/api/anthropic",
      apiKey: "",
      model: "glm-5.2",
      temperature: 0.1
    },
    system: {
      autoProcessEnabled: true,
      autoLoadRemoteImages: false,
      pollIntervalMinutes: 10,
      processLimitPerMailbox: 30
    },
    notification: {
      enabled: false,
      clawbotApiUrl: "http://127.0.0.1:18011/api/send",
      clawbotRecipientId: "",
      importantOnly: true,
      notifyCategories: defaultNotifyCategories
    }
  },
  mailboxes: [],
  emails: [],
  runs: []
};

let stateCache: AppState | undefined;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function ensureDataFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(defaultState, null, 2), "utf8");
  }
}

function loadState(): AppState {
  ensureDataFile();
  if (stateCache) return stateCache;

  const raw = fs.readFileSync(DATA_FILE, "utf8");
  const parsed = JSON.parse(raw) as Partial<AppState>;
  const parsedNotification = parsed.settings?.notification as Partial<NotificationSettings> | undefined;
  const migratedNotifyCategories = parsedNotification?.notifyCategories ?? {
    important: true,
    secondary: parsedNotification?.importantOnly === false,
    ignore: false
  };
  stateCache = {
    settings: {
      ai: { ...defaultState.settings.ai, ...parsed.settings?.ai },
      system: { ...defaultState.settings.system, ...parsed.settings?.system },
      notification: {
        ...defaultState.settings.notification,
        ...parsed.settings?.notification,
        notifyCategories: {
          ...defaultNotifyCategories,
          ...migratedNotifyCategories
        },
        clawbotApiUrl: "http://127.0.0.1:18011/api/send",
        clawbotRecipientId: ""
      }
    },
    mailboxes: parsed.mailboxes ?? [],
    emails: parsed.emails ?? [],
    runs: parsed.runs ?? []
  };
  return stateCache;
}

function saveState(state: AppState) {
  ensureDataFile();
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, DATA_FILE);
  stateCache = state;
}

function includesAny(text: string, words: string[]) {
  return words.some((word) => text.includes(word));
}

function isFinancialRecordEmail(email: ProcessedEmail) {
  const text = [
    email.subject,
    email.fromName,
    email.fromAddress,
    email.toText,
    email.summaryZh,
    email.reasonZh,
    email.originalText,
    email.rawSource
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
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

function processedEmailText(email: ProcessedEmail) {
  return [
    email.subject,
    email.fromName,
    email.fromAddress,
    email.toText,
    email.summaryZh,
    email.reasonZh,
    email.originalText,
    email.rawSource
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

function isSchoolPriorityEmail(email: ProcessedEmail) {
  const text = processedEmailText(email);
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

function isLikelyIgnorableEmail(email: ProcessedEmail) {
  const text = processedEmailText(email);
  return includesAny(text, [
    "unsubscribe",
    "promotion",
    "newsletter",
    "sale",
    "discount",
    "advertisement",
    "marketing",
    "admissions",
    "gift card",
    "退订",
    "促销",
    "折扣",
    "广告",
    "招生",
    "营销"
  ]);
}

function isPromotionalOrNewsEmail(email: ProcessedEmail) {
  const text = processedEmailText(email);
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

export function readState(): AppState {
  return clone(loadState());
}

export function updateState(mutator: (state: AppState) => void): AppState {
  const next = clone(loadState());
  mutator(next);
  saveState(next);
  return clone(next);
}

export function maskSecret(value: string) {
  if (!value) return "";
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 3)}••••${value.slice(-4)}`;
}

export function publicMailbox(mailbox: Mailbox) {
  return {
    ...mailbox,
    password: "",
    hasPassword: Boolean(mailbox.password)
  };
}

export function publicAiSettings(settings: AiSettings) {
  return {
    ...settings,
    apiKey: "",
    hasApiKey: Boolean(settings.apiKey),
    maskedApiKey: maskSecret(settings.apiKey)
  };
}

export function upsertMailbox(input: Omit<Mailbox, "id" | "createdAt" | "updatedAt"> & { id?: string }) {
  const now = new Date().toISOString();
  const state = updateState((draft) => {
    if (input.id) {
      const existing = draft.mailboxes.find((mailbox) => mailbox.id === input.id);
      if (!existing) throw new Error("邮箱不存在");

      const password = input.password || existing.password;
      Object.assign(existing, {
        ...input,
        password,
        updatedAt: now
      });
      return;
    }

    draft.mailboxes.push({
      ...input,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now
    });
  });

  return state.mailboxes;
}

export function removeMailbox(id: string) {
  return updateState((draft) => {
    draft.mailboxes = draft.mailboxes.filter((mailbox) => mailbox.id !== id);
    draft.emails = draft.emails.filter((email) => email.mailboxId !== id);
  });
}

export function updateAiSettings(input: Partial<AiSettings>) {
  return updateState((draft) => {
    draft.settings.ai = {
      ...draft.settings.ai,
      ...input,
      apiKey: input.apiKey || draft.settings.ai.apiKey
    };
  }).settings.ai;
}

export function updateSystemSettings(input: Partial<SystemSettings>) {
  return updateState((draft) => {
    draft.settings.system = {
      ...draft.settings.system,
      ...input
    };
  }).settings.system;
}

export function updateNotificationSettings(input: Partial<NotificationSettings>) {
  return updateState((draft) => {
    const notifyCategories = {
      ...defaultNotifyCategories,
      ...draft.settings.notification.notifyCategories,
      ...input.notifyCategories
    };
    draft.settings.notification = {
      ...draft.settings.notification,
      ...input,
      clawbotApiUrl: "http://127.0.0.1:18011/api/send",
      clawbotRecipientId: "",
      notifyCategories,
      importantOnly: notifyCategories.important && !notifyCategories.secondary && !notifyCategories.ignore
    };
  }).settings.notification;
}

export function hasProcessed(mailboxId: string, externalUid: string) {
  const state = loadState();
  return state.emails.some((email) => email.mailboxId === mailboxId && email.externalUid === externalUid);
}

export function getProcessedEmail(mailboxId: string, externalUid: string) {
  const state = loadState();
  return clone(state.emails.find((email) => email.mailboxId === mailboxId && email.externalUid === externalUid));
}

export function addProcessedEmail(email: ProcessedEmail) {
  let inserted = false;
  updateState((draft) => {
    if (draft.emails.some((item) => item.mailboxId === email.mailboxId && item.externalUid === email.externalUid)) {
      return;
    }
    draft.emails.unshift(email);
    inserted = true;
  });
  return inserted ? clone(email) : undefined;
}

export function updateProcessedEmailReadMark(
  mailboxId: string,
  externalUid: string,
  readMark: { marked: boolean; note?: string }
) {
  updateState((draft) => {
    const email = draft.emails.find((item) => item.mailboxId === mailboxId && item.externalUid === externalUid);
    if (email) {
      email.readMarked = readMark.marked;
      email.readMarkNote = readMark.note;
    }
  });
}

export function updateProcessedEmailNotification(
  id: string,
  patch: Pick<ProcessedEmail, "notifiedAt" | "notificationError">
) {
  updateState((draft) => {
    const email = draft.emails.find((item) => item.id === id);
    if (!email) return;
    email.notifiedAt = patch.notifiedAt;
    email.notificationError = patch.notificationError;
  });
}

export function updateProcessedEmailPanelRead(id: string, panelRead: boolean) {
  const existing = loadState().emails.find((email) => email.id === id);
  if (!existing) throw new Error("邮件不存在");

  const now = new Date().toISOString();
  const state = updateState((draft) => {
    const email = draft.emails.find((item) => item.id === id);
    if (!email) return;
    email.panelRead = panelRead;
    email.panelReadAt = panelRead ? now : undefined;
  });

  return state.emails.find((email) => email.id === id);
}

export function addRun(run: ProcessingRun) {
  updateState((draft) => {
    draft.runs.unshift(run);
    draft.runs = draft.runs.slice(0, 100);
  });
}

export function updateRun(run: ProcessingRun) {
  updateState((draft) => {
    const existing = draft.runs.find((item) => item.id === run.id);
    if (existing) Object.assign(existing, run);
  });
}

export function markInterruptedRuns() {
  let interruptedCount = 0;
  updateState((draft) => {
    const now = new Date().toISOString();
    for (const run of draft.runs) {
      if (run.status === "running") {
        interruptedCount += 1;
        run.status = "failed";
        run.finishedAt = now;
        run.currentStage = "服务重启后已中断";
        run.errors.push("服务重启，上一轮处理任务已中断。");
      }
    }
  });
  return interruptedCount;
}

export function promoteFinancialRecordEmails() {
  let promotedCount = 0;
  updateState((draft) => {
    for (const email of draft.emails) {
      if (email.category === "ignore" && isFinancialRecordEmail(email)) {
        promotedCount += 1;
        email.category = "secondary";
        email.reasonZh = `${email.reasonZh} 系统规则更新：付款回执、扣款确认、收据、账单记录或订单确认类邮件需要留档，至少归为次重要。`;
      }
    }
  });
  return promotedCount;
}

export function promoteSchoolPriorityEmails() {
  let promotedCount = 0;
  updateState((draft) => {
    for (const email of draft.emails) {
      if (email.category !== "important" && isSchoolPriorityEmail(email)) {
        promotedCount += 1;
        email.category = "important";
        email.reasonZh = `${email.reasonZh} ${schoolPriorityReason}`;
        if (!email.actionItemsZh.length) {
          email.actionItemsZh = ["优先打开原件确认是否需要回复、提交材料、参加会议或完成学校相关事项。"];
        }
      }
    }
  });
  return promotedCount;
}

export function repairSchoolPriorityPromotions() {
  let repairedCount = 0;
  updateState((draft) => {
    for (const email of draft.emails) {
      if (
        email.category === "important" &&
        email.reasonZh.includes(schoolPriorityReason) &&
        !isSchoolPriorityEmail(email)
      ) {
        repairedCount += 1;
        email.category = isFinancialRecordEmail(email) ? "secondary" : isLikelyIgnorableEmail(email) ? "ignore" : "secondary";
        email.reasonZh = email.reasonZh.replace(` ${schoolPriorityReason}`, "").replace(schoolPriorityReason, "").trim();
        if (email.actionItemsZh.length === 1 && email.actionItemsZh[0].includes("学校相关事项")) {
          email.actionItemsZh = [];
        }
      }
    }
  });
  return repairedCount;
}

export function demotePromotionalAndNewsEmails() {
  let demotedCount = 0;
  updateState((draft) => {
    for (const email of draft.emails) {
      if (email.category !== "ignore" && !isFinancialRecordEmail(email) && isPromotionalOrNewsEmail(email)) {
        demotedCount += 1;
        email.category = "ignore";
        email.reasonZh = `${email.reasonZh} 系统规则更新：推广、招生、新闻简报或营销类邮件归为不用管。`;
        email.actionItemsZh = [];
      }
    }
  });
  return demotedCount;
}

export function hasInterruptedRecoveryRetry() {
  return loadState().mailboxes.some((mailbox) => mailbox.lastError?.includes("中断恢复扫描超时"));
}

export function updateMailboxSync(id: string, patch: Partial<Pick<Mailbox, "lastSyncAt" | "lastError">>) {
  updateState((draft) => {
    const mailbox = draft.mailboxes.find((item) => item.id === id);
    if (mailbox) {
      Object.assign(mailbox, patch, { updatedAt: new Date().toISOString() });
    }
  });
}
