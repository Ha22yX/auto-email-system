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
