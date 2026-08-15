import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveAiProtocol } from "./ai-protocol";
import type { AiSettings, ProcessedEmail } from "./types";

process.env.DATA_DIR ??= path.join(tmpdir(), `auto-email-system-store-test-${process.pid}`);
process.env.QQ_CREDENTIAL_ENCRYPTION_KEY ??= "test-only-qq-credential-encryption-key";
const {
  addProcessedEmail,
  consumeQqBindingChallenge,
  normalizeAiSettings,
  publicAiSettings,
  publicQqBotSettings,
  readMailboxes,
  readProcessingRuns,
  readQqBotBindings,
  readQqBotConfig,
  readQqState,
  readSettings,
  readState,
  readStoredCredentialEnvelope,
  updateAiSettings,
  updateQqBotSettings,
  updateQqState,
  enqueueNotificationDelivery,
  listNotificationDeliveries
} = await import("./store");

const primaryApiKey = "primary-placeholder-secret";
const multimodalApiKey = "multimodal-placeholder-secret";

const settings: AiSettings = {
  providerName: "Test provider",
  baseUrl: "https://api.example.test/v1",
  apiKey: primaryApiKey,
  model: "test-model",
  temperature: 0.1,
  multimodalEnabled: true,
  multimodalBaseUrl: "https://api.example.test/v1",
  multimodalModel: "test-vision-model",
  multimodalApiKey,
  multimodalMaxAttachmentMb: 8,
  multimodalMaxTotalMb: 18
};

test("public AI settings redact both API keys and expose only safe key metadata", () => {
  const publicSettings = publicAiSettings(settings);
  const serialized = JSON.stringify(publicSettings);

  assert.equal(publicSettings.apiKey, "");
  assert.equal(publicSettings.hasApiKey, true);
  assert.equal(publicSettings.maskedApiKey === primaryApiKey, false);
  assert.equal(serialized.includes(primaryApiKey), false);

  assert.equal(publicSettings.multimodalApiKey, "");
  assert.equal(publicSettings.hasMultimodalApiKey, true);
  assert.equal(publicSettings.maskedMultimodalApiKey === multimodalApiKey, false);
  assert.equal(serialized.includes(multimodalApiKey), false);
  assert.match(publicSettings.maskedMultimodalApiKey, /^mul.+cret$/);
});

test("normalizes legacy settings with migration-safe protocol defaults", () => {
  const legacy = normalizeAiSettings({
    providerName: "Legacy GLM",
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    apiKey: "",
    model: "glm-5.2",
    temperature: 0.1,
    multimodalEnabled: true,
    multimodalBaseUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    multimodalModel: "glm-5v-turbo",
    multimodalMaxAttachmentMb: 8,
    multimodalMaxTotalMb: 18
  });

  assert.equal(legacy.providerPreset, "custom");
  assert.equal(legacy.protocol, "auto");
  assert.equal(legacy.multimodalProtocol, "auto");
  assert.equal(legacy.multimodalApiKey, "");
  assert.equal(resolveAiProtocol(legacy, "text"), "anthropic");
  assert.equal(resolveAiProtocol(legacy, "multimodal"), "openai-chat");
});

test("normalizes unsupported stored protocols to auto", () => {
  const normalized = normalizeAiSettings({
    protocol: "not-a-protocol" as AiSettings["protocol"],
    multimodalProtocol: "not-a-protocol" as AiSettings["multimodalProtocol"]
  });

  assert.equal(normalized.protocol, "auto");
  assert.equal(normalized.multimodalProtocol, "auto");
});

test("retains both saved keys when an update submits blank key fields", () => {
  updateAiSettings({
    ...settings,
    apiKey: "stored-primary-value",
    multimodalApiKey: "stored-multimodal-value"
  });
  updateAiSettings({ apiKey: "", multimodalApiKey: "" });

  const saved = readState().settings.ai;
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");

  assert.equal(digest(saved.apiKey), digest("stored-primary-value"));
  assert.equal(digest(saved.multimodalApiKey ?? ""), digest("stored-multimodal-value"));
});


test("QQ AppSecret is encrypted and never returned by public settings", () => {
  updateQqBotSettings({ appId: "1900000000", appSecret: "test-secret", enabled: false });
  const config = readQqBotConfig();
  const publicSettings = publicQqBotSettings(config);
  const envelope = readStoredCredentialEnvelope("qq-app-secret");

  assert.equal(publicSettings.hasAppSecret, true);
  assert.deepEqual(Object.keys(publicSettings).sort(), [
    "appId",
    "enabled",
    "hasAppSecret",
    "maskedAppSecret",
    "notifyCategories"
  ]);
  assert.equal(JSON.stringify(publicSettings).includes("test-secret"), false);
  assert.equal(JSON.stringify(publicSettings).includes(envelope), false);
  assert.equal("appSecret" in publicSettings, false);
  assert.equal("encryptedAppSecret" in publicSettings, false);
  assert.equal(config.encryptedAppSecret, envelope);
  assert.equal(envelope.includes("test-secret"), false);
});

test("blank QQ AppSecret updates retain the saved credential", () => {
  updateQqBotSettings({ appId: "1900000000", appSecret: "retained-test-secret", enabled: false });
  updateQqBotSettings({ appId: "1900000001", appSecret: "", enabled: true });

  const config = readQqBotConfig();
  const publicSettings = publicQqBotSettings(config);
  assert.equal(config.appId, "1900000001");
  assert.equal(publicSettings.enabled, true);
  assert.equal(publicSettings.hasAppSecret, true);
  assert.equal(JSON.stringify(publicSettings).includes("retained-test-secret"), false);
});

test("QQ settings and AppSecret roll back together when settings persistence fails", () => {
  updateQqBotSettings({ appId: "1900000100", appSecret: "old-test-secret", enabled: false });
  const before = readQqBotConfig();
  const sqlite = new DatabaseSync(path.join(process.env.DATA_DIR!, "app.sqlite"));
  sqlite.exec(`
    CREATE TRIGGER reject_qq_settings_update
    BEFORE INSERT ON settings
    WHEN NEW.key = 'notification.qq'
    BEGIN
      SELECT RAISE(ABORT, 'forced QQ settings write failure');
    END;
  `);

  try {
    assert.throws(() =>
      updateQqBotSettings({ appId: "1900000101", appSecret: "new-test-secret", enabled: true })
    );
  } finally {
    sqlite.exec("DROP TRIGGER reject_qq_settings_update");
    sqlite.close();
  }

  assert.deepEqual(readQqBotConfig(), before);
  assert.equal(readStoredCredentialEnvelope("qq-app-secret"), before.encryptedAppSecret);
});

test("QQ binding challenge is consumed atomically and only once", () => {
  const challenge = {
    id: `challenge-${process.pid}`,
    salt: "test-salt",
    codeHash: "a".repeat(64),
    createdAt: "2026-08-16T00:00:00.000Z",
    expiresAt: "2026-08-16T00:10:00.000Z"
  };
  updateQqState("binding-challenge", challenge);

  const input = {
    id: "primary",
    userOpenId: "test-user-openid",
    friendshipStatus: "friend" as const,
    proactiveStatus: "unknown" as const,
    lastEventAt: "2026-08-16T00:05:00.000Z"
  };
  const first = consumeQqBindingChallenge(
    "binding-challenge",
    challenge.id,
    input,
    "2026-08-16T00:05:00.000Z"
  );
  const second = consumeQqBindingChallenge(
    "binding-challenge",
    challenge.id,
    { ...input, userOpenId: "should-not-replace" },
    "2026-08-16T00:05:01.000Z"
  );

  assert.equal(first?.userOpenId, "test-user-openid");
  assert.equal(second, undefined);
  assert.equal(readQqBotBindings().find((binding) => binding.id === "primary")?.userOpenId, "test-user-openid");
  assert.equal(
    readQqState<{ consumedAt?: string }>("binding-challenge")?.consumedAt,
    "2026-08-16T00:05:00.000Z"
  );
});

test("expired QQ binding challenges cannot replace a recipient", () => {
  updateQqState("binding-challenge", {
    id: "expired-challenge",
    expiresAt: "2026-08-16T00:00:00.000Z"
  });
  const result = consumeQqBindingChallenge(
    "binding-challenge",
    "expired-challenge",
    { id: "primary", userOpenId: "expired-user", friendshipStatus: "friend", proactiveStatus: "unknown" },
    "2026-08-16T00:00:01.000Z"
  );
  assert.equal(result, undefined);
  assert.equal(readQqBotBindings().find((binding) => binding.id === "primary")?.userOpenId, "test-user-openid");
});
test("delivery identity is unique per email and channel", () => {
  const emailId = `email-delivery-${process.pid}`;
  enqueueNotificationDelivery(emailId, "qq");
  enqueueNotificationDelivery(emailId, "qq");

  assert.equal(listNotificationDeliveries({ emailId }).length, 1);
});

test("lightweight state readers never parse stored email bodies", () => {
  const bodyMarker = "email-body-must-not-be-parsed-" + process.pid;
  const email: ProcessedEmail = {
    id: "memory-regression-" + process.pid,
    mailboxId: "memory-regression-mailbox",
    externalUid: "1",
    subject: "Memory regression",
    processedAt: new Date().toISOString(),
    category: "ignore",
    summaryZh: "memory regression",
    reasonZh: "lightweight reader verification",
    actionItemsZh: [],
    originalText: bodyMarker,
    readMarked: true
  };
  addProcessedEmail(email);

  const originalParse = JSON.parse;
  let parsedStoredEmail = false;
  JSON.parse = ((value: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
    if (String(value).includes(bodyMarker)) {
      parsedStoredEmail = true;
      throw new Error("lightweight reader parsed an email body");
    }
    return originalParse(value, reviver);
  }) as typeof JSON.parse;

  try {
    assert.doesNotThrow(() => readSettings());
    assert.doesNotThrow(() => readMailboxes());
    assert.doesNotThrow(() => readProcessingRuns(10));
  } finally {
    JSON.parse = originalParse;
  }

  assert.equal(parsedStoredEmail, false);
});
