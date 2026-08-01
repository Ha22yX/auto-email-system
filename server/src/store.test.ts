import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AiSettings } from "./types";

process.env.DATA_DIR ??= path.join(tmpdir(), `auto-email-system-store-test-${process.pid}`);
const { publicAiSettings } = await import("./store");

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
  assert.notEqual(publicSettings.maskedApiKey, primaryApiKey);
  assert.equal(serialized.includes(primaryApiKey), false);

  assert.equal(publicSettings.multimodalApiKey, "");
  assert.equal(publicSettings.hasMultimodalApiKey, true);
  assert.notEqual(publicSettings.maskedMultimodalApiKey, multimodalApiKey);
  assert.equal(serialized.includes(multimodalApiKey), false);
  assert.match(publicSettings.maskedMultimodalApiKey, /^mul.+cret$/);
});
