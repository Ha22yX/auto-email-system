import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveAiProtocol } from "./ai-protocol";
import type { AiSettings, ProcessedEmail } from "./types";

process.env.DATA_DIR ??= path.join(tmpdir(), `auto-email-system-store-test-${process.pid}`);
const {
  addProcessedEmail,
  normalizeAiSettings,
  publicAiSettings,
  readMailboxes,
  readProcessingRuns,
  readSettings,
  readState,
  updateAiSettings
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
