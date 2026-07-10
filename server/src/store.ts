import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createAuthSettings, verifyPassword } from "./auth-crypto";
import { publishAppEvent } from "./events";
import type {
  AiSettings,
  AppState,
  AuthSettings,
  IncomingEmail,
  MailCategory,
  Mailbox,
  NotificationSettings,
  ProcessedEmail,
  ProcessingRun,
  SystemSettings
} from "./types";

const DATA_DIR = path.resolve(process.env.DATA_DIR ?? "data");
const JSON_DATA_FILE = path.join(DATA_DIR, "app.db.json");
const SQLITE_FILE = path.join(DATA_DIR, "app.sqlite");
const SCHEMA_VERSION = 1;

const defaultNotifyCategories: Record<MailCategory, boolean> = {
  important: true,
  secondary: true,
  ignore: false
};

const defaultState: AppState = {
  settings: {
    ai: {
      providerName: "智谱 GLM Coding Plan",
      baseUrl: "https://open.bigmodel.cn/api/anthropic",
      apiKey: "",
      model: "glm-5.2",
      temperature: 0.1,
      multimodalEnabled: true,
      multimodalBaseUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      multimodalModel: "glm-5v-turbo",
      multimodalMaxAttachmentMb: 8,
      multimodalMaxTotalMb: 18
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
    },
    auth: createAuthSettings()
  },
  mailboxes: [],
  emails: [],
  runs: []
};

type SqlRow = Record<string, unknown>;

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(SQLITE_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS mailboxes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    data TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS emails (
    id TEXT PRIMARY KEY,
    mailboxId TEXT NOT NULL,
    externalUid TEXT NOT NULL,
    messageId TEXT,
    subject TEXT NOT NULL,
    fromName TEXT,
    fromAddress TEXT,
    toText TEXT,
    receivedAt TEXT,
    processedAt TEXT NOT NULL,
    category TEXT NOT NULL,
    summaryZh TEXT NOT NULL,
    panelRead INTEGER NOT NULL DEFAULT 0,
    readMarked INTEGER NOT NULL DEFAULT 0,
    notifiedAt TEXT,
    notificationError TEXT,
    contentFingerprint TEXT NOT NULL,
    data TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_mailbox_uid ON emails(mailboxId, externalUid);
  CREATE INDEX IF NOT EXISTS idx_emails_category_processed ON emails(category, processedAt DESC);
  CREATE INDEX IF NOT EXISTS idx_emails_mailbox_processed ON emails(mailboxId, processedAt DESC);
  CREATE INDEX IF NOT EXISTS idx_emails_panel_read ON emails(category, panelRead);
  CREATE INDEX IF NOT EXISTS idx_emails_message_id ON emails(mailboxId, messageId);
  CREATE INDEX IF NOT EXISTS idx_emails_fingerprint ON emails(mailboxId, contentFingerprint);
  CREATE INDEX IF NOT EXISTS idx_emails_notification_retry ON emails(notificationError, notifiedAt);

  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    startedAt TEXT NOT NULL,
    finishedAt TEXT,
    mailboxId TEXT,
    data TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(startedAt DESC);
  CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status, startedAt DESC);

  CREATE TABLE IF NOT EXISTS processing_events (
    id TEXT PRIMARY KEY,
    runId TEXT,
    mailboxId TEXT,
    emailId TEXT,
    subject TEXT,
    stage TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT,
    createdAt TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_processing_events_run ON processing_events(runId, createdAt DESC);
  CREATE INDEX IF NOT EXISTS idx_processing_events_mailbox ON processing_events(mailboxId, createdAt DESC);
`);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function bool(value: unknown) {
  return value ? 1 : 0;
}

function parseBool(value: unknown) {
  return Number(value) === 1;
}

function normalizeFingerprintText(value?: string) {
  return (value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function emailContentFingerprint(email: IncomingEmail | ProcessedEmail) {
  const parts = [
    email.mailboxId,
    normalizeFingerprintText(email.subject),
    normalizeFingerprintText(email.fromAddress),
    normalizeFingerprintText(email.toText),
    email.receivedAt || "",
    normalizeFingerprintText(email.originalText).slice(0, 8000)
  ];
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

function parseJson<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

function setMeta(key: string, value: string) {
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
}

function getMeta(key: string) {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as SqlRow | undefined;
  return row ? String(row.value) : undefined;
}

function normalizeState(parsed: Partial<AppState>): AppState {
  const parsedNotification = parsed.settings?.notification as Partial<NotificationSettings> | undefined;
  const parsedAuth = parsed.settings?.auth as Partial<AuthSettings> | undefined;
  const migratedNotifyCategories =
    parsedNotification?.notifyCategories ??
    (parsedNotification
      ? {
          important: true,
          secondary: parsedNotification.importantOnly === false,
          ignore: false
        }
      : defaultNotifyCategories);
  const auth =
    parsedAuth?.passwordHash && parsedAuth.passwordSalt
      ? {
          ...defaultState.settings.auth,
          ...parsedAuth,
          passwordIterations: parsedAuth.passwordIterations ?? defaultState.settings.auth.passwordIterations
        }
      : createAuthSettings();

  return {
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
      },
      auth
    },
    mailboxes: parsed.mailboxes ?? [],
    emails: (parsed.emails ?? []).map((email) => ({
      ...email,
      panelRead: email.panelRead ?? email.category === "ignore"
    })),
    runs: parsed.runs ?? []
  };
}

function insertSettings(settings: AppState["settings"]) {
  const statement = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
  statement.run("ai", JSON.stringify(settings.ai));
  statement.run("system", JSON.stringify(settings.system));
  statement.run("notification", JSON.stringify(settings.notification));
  statement.run("auth", JSON.stringify(settings.auth));
}

function insertMailbox(mailbox: Mailbox) {
  db.prepare(
    `INSERT OR REPLACE INTO mailboxes (id, name, email, enabled, createdAt, updatedAt, data)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    mailbox.id,
    mailbox.name,
    mailbox.email,
    bool(mailbox.enabled),
    mailbox.createdAt,
    mailbox.updatedAt,
    JSON.stringify(mailbox)
  );
}

function insertEmail(email: ProcessedEmail) {
  const normalized: ProcessedEmail = {
    ...email,
    panelRead: email.panelRead ?? email.category === "ignore"
  };
  db.prepare(
    `INSERT OR REPLACE INTO emails (
      id, mailboxId, externalUid, messageId, subject, fromName, fromAddress, toText, receivedAt,
      processedAt, category, summaryZh, panelRead, readMarked, notifiedAt, notificationError,
      contentFingerprint, data
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    normalized.id,
    normalized.mailboxId,
    normalized.externalUid,
    normalizeFingerprintText(normalized.messageId) || null,
    normalized.subject,
    normalized.fromName ?? null,
    normalized.fromAddress ?? null,
    normalized.toText ?? null,
    normalized.receivedAt ?? null,
    normalized.processedAt,
    normalized.category,
    normalized.summaryZh,
    bool(normalized.panelRead),
    bool(normalized.readMarked),
    normalized.notifiedAt ?? null,
    normalized.notificationError ?? null,
    emailContentFingerprint(normalized),
    JSON.stringify(normalized)
  );
}

function insertRun(run: ProcessingRun) {
  db.prepare(
    `INSERT OR REPLACE INTO runs (id, status, startedAt, finishedAt, mailboxId, data)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(run.id, run.status, run.startedAt, run.finishedAt ?? null, run.mailboxId ?? null, JSON.stringify(run));
}

function replaceState(state: AppState) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DELETE FROM settings; DELETE FROM mailboxes; DELETE FROM emails; DELETE FROM runs;");
    insertSettings(state.settings);
    for (const mailbox of state.mailboxes) insertMailbox(mailbox);
    for (const email of state.emails) insertEmail(email);
    for (const run of state.runs.slice(0, 100)) insertRun(run);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function ensureInitialized() {
  if (getMeta("schemaVersion")) return;

  let initialState = defaultState;
  if (fs.existsSync(JSON_DATA_FILE)) {
    const raw = fs.readFileSync(JSON_DATA_FILE, "utf8");
    initialState = normalizeState(JSON.parse(raw) as Partial<AppState>);
  }

  replaceState(initialState);
  setMeta("schemaVersion", String(SCHEMA_VERSION));
  if (fs.existsSync(JSON_DATA_FILE)) {
    setMeta("jsonMigratedAt", new Date().toISOString());
  }
}

ensureInitialized();

function getSetting<T>(key: keyof AppState["settings"], fallback: T): T {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(String(key)) as SqlRow | undefined;
  return row ? parseJson<T>(row.value) : clone(fallback);
}

function getSettings(): AppState["settings"] {
  const notification = getSetting<NotificationSettings>("notification", defaultState.settings.notification);
  return {
    ai: getSetting<AiSettings>("ai", defaultState.settings.ai),
    system: getSetting<SystemSettings>("system", defaultState.settings.system),
    notification: {
      ...defaultState.settings.notification,
      ...notification,
      notifyCategories: {
        ...defaultNotifyCategories,
        ...notification.notifyCategories
      },
      clawbotApiUrl: "http://127.0.0.1:18011/api/send",
      clawbotRecipientId: ""
    },
    auth: getSetting<AuthSettings>("auth", defaultState.settings.auth)
  };
}

function rowToMailbox(row: SqlRow): Mailbox {
  return parseJson<Mailbox>(row.data);
}

function rowToEmail(row: SqlRow): ProcessedEmail {
  const email = parseJson<ProcessedEmail>(row.data);
  return {
    ...email,
    panelRead: email.panelRead ?? email.category === "ignore"
  };
}

function rowToRun(row: SqlRow): ProcessingRun {
  return parseJson<ProcessingRun>(row.data);
}

function getAllMailboxes() {
  return (db.prepare("SELECT data FROM mailboxes ORDER BY createdAt ASC, name ASC").all() as SqlRow[]).map(rowToMailbox);
}

function getAllEmails() {
  return (db.prepare("SELECT data FROM emails ORDER BY processedAt DESC").all() as SqlRow[]).map(rowToEmail);
}

function getRuns(limit = 100) {
  return (db.prepare("SELECT data FROM runs ORDER BY startedAt DESC LIMIT ?").all(limit) as SqlRow[]).map(rowToRun);
}

export function readState(): AppState {
  return {
    settings: clone(getSettings()),
    mailboxes: getAllMailboxes(),
    emails: getAllEmails(),
    runs: getRuns(100)
  };
}

export function updateState(mutator: (state: AppState) => void): AppState {
  const next = readState();
  mutator(next);
  replaceState(next);
  publishAppEvent("state", {});
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

export function publicAuthSettings(settings: AuthSettings) {
  return {
    passwordUpdatedAt: settings.passwordUpdatedAt,
    sessionDays: 7
  };
}

export function upsertMailbox(input: Omit<Mailbox, "id" | "createdAt" | "updatedAt"> & { id?: string }) {
  const now = new Date().toISOString();
  let saved: Mailbox;
  if (input.id) {
    const existing = getAllMailboxes().find((mailbox) => mailbox.id === input.id);
    if (!existing) throw new Error("邮箱不存在");
    saved = {
      ...existing,
      ...input,
      password: input.password || existing.password,
      updatedAt: now
    };
  } else {
    saved = {
      ...input,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now
    };
  }

  insertMailbox(saved);
  publishAppEvent("mailboxes", { id: saved.id });
  return getAllMailboxes();
}

export function removeMailbox(id: string) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM emails WHERE mailboxId = ?").run(id);
    db.prepare("DELETE FROM mailboxes WHERE id = ?").run(id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  publishAppEvent("mailboxes", { id });
  publishAppEvent("emails", { mailboxId: id });
  return readState();
}

export function updateAiSettings(input: Partial<AiSettings>) {
  const current = getSettings().ai;
  const next = {
    ...current,
    ...input,
    apiKey: input.apiKey || current.apiKey
  };
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("ai", JSON.stringify(next));
  publishAppEvent("settings", { key: "ai" });
  return next;
}

export function updateSystemSettings(input: Partial<SystemSettings>) {
  const next = {
    ...getSettings().system,
    ...input
  };
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("system", JSON.stringify(next));
  publishAppEvent("settings", { key: "system" });
  return next;
}

export function updateNotificationSettings(input: Partial<NotificationSettings>) {
  const current = getSettings().notification;
  const notifyCategories = {
    ...defaultNotifyCategories,
    ...current.notifyCategories,
    ...input.notifyCategories
  };
  const next = {
    ...current,
    ...input,
    clawbotApiUrl: "http://127.0.0.1:18011/api/send",
    clawbotRecipientId: "",
    notifyCategories,
    importantOnly: notifyCategories.important && !notifyCategories.secondary && !notifyCategories.ignore
  };
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("notification", JSON.stringify(next));
  publishAppEvent("settings", { key: "notification" });
  return next;
}

export function verifyAdminPassword(password: string) {
  return verifyPassword(password, getSettings().auth);
}

export function updateAuthPassword(currentPassword: string, newPassword: string) {
  const current = getSettings().auth;
  if (!verifyPassword(currentPassword, current)) {
    throw new Error("当前登录密码不正确。");
  }

  const next = createAuthSettings(newPassword);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("auth", JSON.stringify(next));
  publishAppEvent("settings", { key: "auth" });
  return next;
}

export function hasProcessed(mailboxId: string, externalUid: string) {
  const row = db
    .prepare("SELECT 1 FROM emails WHERE mailboxId = ? AND externalUid = ? LIMIT 1")
    .get(mailboxId, externalUid);
  return Boolean(row);
}

export function getProcessedEmail(mailboxId: string, externalUid: string) {
  const row = db
    .prepare("SELECT data FROM emails WHERE mailboxId = ? AND externalUid = ? LIMIT 1")
    .get(mailboxId, externalUid) as SqlRow | undefined;
  return row ? clone(rowToEmail(row)) : undefined;
}

export function getProcessedEmailById(id: string) {
  const row = db.prepare("SELECT data FROM emails WHERE id = ? LIMIT 1").get(id) as SqlRow | undefined;
  return row ? clone(rowToEmail(row)) : undefined;
}

export function findProcessedEmailDuplicate(email: IncomingEmail | ProcessedEmail) {
  const messageId = normalizeFingerprintText(email.messageId);
  if (messageId) {
    const byMessageId = db
      .prepare("SELECT data FROM emails WHERE mailboxId = ? AND messageId = ? LIMIT 1")
      .get(email.mailboxId, messageId) as SqlRow | undefined;
    if (byMessageId) return clone(rowToEmail(byMessageId));
  }

  const fingerprint = emailContentFingerprint(email);
  const row = db
    .prepare(
      "SELECT data FROM emails WHERE mailboxId = ? AND externalUid <> ? AND contentFingerprint = ? LIMIT 1"
    )
    .get(email.mailboxId, email.externalUid, fingerprint) as SqlRow | undefined;
  return row ? clone(rowToEmail(row)) : undefined;
}

export function addProcessedEmail(email: ProcessedEmail) {
  const messageId = normalizeFingerprintText(email.messageId);
  const fingerprint = emailContentFingerprint(email);
  const existing = messageId
    ? db
        .prepare(
          `SELECT id FROM emails
           WHERE mailboxId = ? AND (externalUid = ? OR messageId = ? OR contentFingerprint = ?)
           LIMIT 1`
        )
        .get(email.mailboxId, email.externalUid, messageId, fingerprint)
    : db
        .prepare(
          `SELECT id FROM emails
           WHERE mailboxId = ? AND (externalUid = ? OR contentFingerprint = ?)
           LIMIT 1`
        )
        .get(email.mailboxId, email.externalUid, fingerprint);
  if (existing) return undefined;

  insertEmail(email);
  publishAppEvent("email", { id: email.id, mailboxId: email.mailboxId, category: email.category });
  return clone({
    ...email,
    panelRead: email.panelRead ?? email.category === "ignore"
  });
}

function updateEmailByLookup(mailboxId: string, externalUid: string, mutator: (email: ProcessedEmail) => void) {
  const email = getProcessedEmail(mailboxId, externalUid);
  if (!email) return undefined;
  mutator(email);
  insertEmail(email);
  publishAppEvent("email", { id: email.id, mailboxId, category: email.category });
  return email;
}

export function updateProcessedEmailReadMark(
  mailboxId: string,
  externalUid: string,
  readMark: { marked: boolean; note?: string }
) {
  updateEmailByLookup(mailboxId, externalUid, (email) => {
    email.readMarked = readMark.marked;
    email.readMarkNote = readMark.note;
  });
}

export function updateProcessedEmailNotification(
  id: string,
  patch: Pick<ProcessedEmail, "notifiedAt" | "notificationError">
) {
  const email = getProcessedEmailById(id);
  if (!email) return;
  email.notifiedAt = patch.notifiedAt;
  email.notificationError = patch.notificationError;
  insertEmail(email);
  publishAppEvent("email", { id, mailboxId: email.mailboxId, category: email.category });
}

export function updateProcessedEmailPanelRead(id: string, panelRead: boolean) {
  const email = getProcessedEmailById(id);
  if (!email) throw new Error("邮件不存在");

  email.panelRead = panelRead;
  email.panelReadAt = panelRead ? new Date().toISOString() : undefined;
  insertEmail(email);
  publishAppEvent("email", { id, mailboxId: email.mailboxId, category: email.category });
  return email;
}

export function addRun(run: ProcessingRun) {
  insertRun(run);
  const rows = db.prepare("SELECT id FROM runs ORDER BY startedAt DESC LIMIT -1 OFFSET 100").all() as SqlRow[];
  for (const row of rows) db.prepare("DELETE FROM runs WHERE id = ?").run(String(row.id));
  publishAppEvent("run", { id: run.id, status: run.status });
}

export function updateRun(run: ProcessingRun) {
  insertRun(run);
  publishAppEvent("run", { id: run.id, status: run.status });
}

export function markInterruptedRuns() {
  const runningRuns = (db.prepare("SELECT data FROM runs WHERE status = ?").all("running") as SqlRow[]).map(rowToRun);
  const now = new Date().toISOString();
  for (const run of runningRuns) {
    run.status = "failed";
    run.finishedAt = now;
    run.currentStage = "服务重启后已中断";
    run.errors.push("服务重启，上一轮处理任务已中断。");
    insertRun(run);
  }
  if (runningRuns.length) publishAppEvent("run", { interruptedCount: runningRuns.length });
  return runningRuns.length;
}

export function hasInterruptedRecoveryRetry() {
  return getAllMailboxes().some((mailbox) => mailbox.lastError?.includes("中断恢复扫描超时"));
}

export function updateMailboxSync(id: string, patch: Partial<Pick<Mailbox, "lastSyncAt" | "lastError">>) {
  const mailbox = getAllMailboxes().find((item) => item.id === id);
  if (!mailbox) return;
  insertMailbox({
    ...mailbox,
    ...patch,
    updatedAt: new Date().toISOString()
  });
  publishAppEvent("mailboxes", { id });
}

export function queryProcessedEmails(options: {
  category?: string;
  mailboxId?: string;
  q?: string;
  offset?: number;
  limit?: number;
}) {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  const allowedCategories = new Set(["important", "secondary", "ignore"]);

  if (options.category && allowedCategories.has(options.category)) {
    where.push("category = ?");
    params.push(options.category);
  }
  if (options.mailboxId && options.mailboxId !== "all") {
    where.push("mailboxId = ?");
    params.push(options.mailboxId);
  }
  if (options.q?.trim()) {
    where.push("(subject LIKE ? OR fromName LIKE ? OR fromAddress LIKE ? OR summaryZh LIKE ?)");
    const query = `%${options.q.trim()}%`;
    params.push(query, query, query, query);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const totalRow = db.prepare(`SELECT COUNT(*) AS total FROM emails ${whereSql}`).get(...params) as SqlRow;
  const limit = Math.min(100, Math.max(20, Math.floor(options.limit ?? 40)));
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const rows = db
    .prepare(`SELECT data FROM emails ${whereSql} ORDER BY processedAt DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as SqlRow[];

  const total = Number(totalRow.total ?? 0);
  return {
    items: rows.map(rowToEmail),
    total,
    offset,
    limit,
    hasMoreBefore: offset > 0,
    hasMoreAfter: offset + rows.length < total
  };
}

export function getDashboardData(mailboxId?: string) {
  const selectedMailbox = mailboxId && mailboxId !== "all" ? mailboxId : undefined;
  const whereSql = selectedMailbox ? "WHERE mailboxId = ?" : "";
  const params = selectedMailbox ? [selectedMailbox] : [];

  const counts: Record<MailCategory, number> = { important: 0, secondary: 0, ignore: 0 };
  const unreadCounts: Record<MailCategory, number> = { important: 0, secondary: 0, ignore: 0 };
  for (const row of db.prepare(`SELECT category, COUNT(*) AS total FROM emails ${whereSql} GROUP BY category`).all(
    ...params
  ) as SqlRow[]) {
    counts[row.category as MailCategory] = Number(row.total ?? 0);
  }
  const unreadWhere = `${whereSql}${whereSql ? " AND" : "WHERE"} panelRead = 0`;
  for (const row of db.prepare(`SELECT category, COUNT(*) AS total FROM emails ${unreadWhere} GROUP BY category`).all(
    ...params
  ) as SqlRow[]) {
    unreadCounts[row.category as MailCategory] = Number(row.total ?? 0);
  }

  const total = Number(
    (db.prepare(`SELECT COUNT(*) AS total FROM emails ${whereSql}`).get(...params) as SqlRow).total ?? 0
  );
  const allTotal = Number((db.prepare("SELECT COUNT(*) AS total FROM emails").get() as SqlRow).total ?? 0);
  const recentEmails = (
    db.prepare(`SELECT data FROM emails ${whereSql} ORDER BY processedAt DESC LIMIT 8`).all(...params) as SqlRow[]
  ).map(rowToEmail);
  const currentRunRow = db
    .prepare("SELECT data FROM runs WHERE status = ? ORDER BY startedAt DESC LIMIT 1")
    .get("running") as SqlRow | undefined;

  return {
    state: {
      settings: getSettings(),
      mailboxes: getAllMailboxes(),
      runs: getRuns(10)
    },
    counts,
    unreadCounts,
    total,
    allTotal,
    recentEmails,
    currentRun: currentRunRow ? rowToRun(currentRunRow) : null
  };
}

export function getMaxProcessedUid(mailboxId: string) {
  const rows = db.prepare("SELECT externalUid FROM emails WHERE mailboxId = ?").all(mailboxId) as SqlRow[];
  let max = 0;
  for (const row of rows) {
    const uid = Number(row.externalUid);
    if (Number.isFinite(uid) && uid > max) max = uid;
  }
  return max;
}

export function getPendingNotificationEmails(limit = 20) {
  return (
    db
      .prepare(
        `SELECT data FROM emails
         WHERE COALESCE(notificationError, '') <> '' AND notifiedAt IS NULL
         ORDER BY processedAt DESC
         LIMIT ?`
      )
      .all(limit) as SqlRow[]
  ).map(rowToEmail);
}

export function recordProcessingEvent(input: {
  runId?: string;
  mailboxId?: string;
  emailId?: string;
  subject?: string;
  stage: string;
  status: string;
  message?: string;
}) {
  const event = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    ...input
  };
  db.prepare(
    `INSERT INTO processing_events (id, runId, mailboxId, emailId, subject, stage, status, message, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    event.id,
    event.runId ?? null,
    event.mailboxId ?? null,
    event.emailId ?? null,
    event.subject ?? null,
    event.stage,
    event.status,
    event.message ?? null,
    event.createdAt
  );
  publishAppEvent("processing-event", event);
  return event;
}
