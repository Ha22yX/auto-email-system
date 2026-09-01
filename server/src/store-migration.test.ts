import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const fixtureScript = `
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const dataDir = process.env.DATA_DIR;
const sqliteFile = path.join(dataDir, "app.sqlite");
if (process.env.SEED_SCHEMA_V1 === "true") {
  fs.mkdirSync(dataDir, { recursive: true });
  const fixture = new DatabaseSync(sqliteFile);
  fixture.exec(\`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE emails (
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
  \`);
  const legacySettings = {
    enabled: true,
    clawbotApiUrl: "http://127.0.0.1:18011/api/send",
    clawbotRecipientId: "",
    importantOnly: true,
    notifyCategories: { important: true, secondary: false, ignore: false }
  };
  fixture.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("schemaVersion", "1");
  fixture.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("notification", JSON.stringify(legacySettings));
  const insertEmail = fixture.prepare(\`
    INSERT INTO emails (
      id, mailboxId, externalUid, subject, processedAt, category, summaryZh, readMarked,
      notifiedAt, notificationError, contentFingerprint, data
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  \`);
  insertEmail.run("legacy-sent", "mailbox", "1", "sent", "2026-08-15T00:00:00.000Z", "important", "sent", 1,
    "2026-08-15T00:01:00.000Z", null, "sent-fingerprint", "{}");
  insertEmail.run("legacy-retry", "mailbox", "2", "retry", "2026-08-15T00:00:00.000Z", "important", "retry", 1,
    null, "legacy failure", "retry-fingerprint", "{}");
  fixture.close();
}

const store = await import(process.env.STORE_MODULE_URL);
const db = new DatabaseSync(sqliteFile);
const setting = (key) => JSON.parse(db.prepare("SELECT value FROM settings WHERE key = ?").get(key).value);
const tableNames = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
const indexNames = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((row) => row.name);
const uniqueDeliveryIndex = db.prepare("PRAGMA index_list('notification_deliveries')").all().some((index) => {
  if (!index.unique) return false;
  const columns = db.prepare(\`PRAGMA index_info('\${index.name}')\`).all().map((column) => column.name);
  return columns.join(",") === "emailId,channel";
});
const beforeEnqueue = db.prepare("SELECT emailId, channel, status FROM notification_deliveries ORDER BY emailId").all();
const sentDelivery = store.enqueueNotificationDelivery("legacy-sent", "wechat");
const afterEnqueue = db.prepare("SELECT emailId, channel, status FROM notification_deliveries ORDER BY emailId").all();
const result = {
  wechat: setting("notification.wechat"),
  qq: setting("notification.qq"),
  beforeEnqueue,
  afterEnqueue,
  sentDelivery,
  tableNames,
  indexNames,
  uniqueDeliveryIndex
};
db.close();
process.stdout.write(JSON.stringify(result));
`;

function createSchemaV1Fixture() {
  const dataDir = fs.mkdtempSync(path.join(tmpdir(), "auto-email-system-schema-v1-"));
  return { dataDir, run: (seedSchemaV1: boolean) => runFixture(dataDir, seedSchemaV1) };
}

function runFixture(dataDir: string, seedSchemaV1: boolean) {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", fixtureScript], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      QQ_CREDENTIAL_ENCRYPTION_KEY: "test-only-qq-credential-encryption-key",
      SEED_SCHEMA_V1: String(seedSchemaV1),
      STORE_MODULE_URL: pathToFileURL(path.join(process.cwd(), "server/src/store.ts")).href
    },
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as {
    wechat: { enabled: boolean };
    qq: { enabled: boolean; appId: string; encryptedAppSecret: string };
    beforeEnqueue: Array<{ emailId: string; channel: string; status: string }>;
    afterEnqueue: Array<{ emailId: string; channel: string; status: string }>;
    sentDelivery: { status: string };
    tableNames: string[];
    indexNames: string[];
    uniqueDeliveryIndex: boolean;
  };
}

test("schema-v1 migration creates durable channel state idempotently", () => {
  const fixture = createSchemaV1Fixture();
  const first = fixture.run(true);
  const second = fixture.run(false);

  assert.deepEqual(first.wechat, { enabled: true, clawbotApiUrl: "http://127.0.0.1:18011/api/send", clawbotRecipientId: "", importantOnly: true, notifyCategories: { important: true, secondary: false, ignore: false } });
  assert.deepEqual(first.qq, {
    enabled: false,
    appId: "",
    encryptedAppSecret: "",
    notifyCategories: { important: true, secondary: true, ignore: false },
    quoteImageMarksRead: true,
    agent: {
      enabled: false,
      requireConfirmation: true,
      maxResults: 6,
      permissions: {
        readMail: true,
        sendMailImages: true,
        manageReadState: true,
        manageNotifications: true,
        runProcessing: true,
        checkMailboxes: true,
        reclassifyMail: true
      }
    }
  });
  assert.deepEqual(first.beforeEnqueue, [
    { emailId: "legacy-retry", channel: "wechat", status: "retry" },
    { emailId: "legacy-sent", channel: "wechat", status: "sent" }
  ]);
  assert.equal(first.sentDelivery.status, "sent");
  assert.deepEqual(first.afterEnqueue, first.beforeEnqueue);
  assert.equal(first.uniqueDeliveryIndex, true);
  assert.deepEqual(
    ["credentials", "qq_state", "qq_event_dedupe", "notification_deliveries", "qq_notification_refs", "qq_email_read_actions", "qq_agent_events"].every((table) => first.tableNames.includes(table)),
    true
  );
  assert.deepEqual(
    ["idx_notification_deliveries_status_next_attempt", "idx_qq_event_dedupe_expires", "idx_qq_notification_refs_ref"].every((index) =>
      first.indexNames.includes(index)
    ),
    true
  );

  assert.deepEqual(second.beforeEnqueue, first.beforeEnqueue);
  assert.deepEqual(second.afterEnqueue, first.afterEnqueue);
});
