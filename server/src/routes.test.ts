import assert from "node:assert/strict";
import test from "node:test";
import type { AiSettings, ClassificationResult } from "./types";

const { buildAiTestDiagnostics, withSavedAiTestKeys } = await import("./routes");

function settings(overrides: Partial<AiSettings> = {}): AiSettings {
  return {
    providerName: "Test provider",
    providerPreset: "custom",
    baseUrl: "https://api.example.test/v1",
    apiKey: "primary-key",
    model: "test-model",
    temperature: 0.1,
    protocol: "auto",
    multimodalEnabled: true,
    multimodalBaseUrl: "https://vision.example.test/v1",
    multimodalModel: "vision-model",
    multimodalProtocol: "auto",
    multimodalApiKey: "vision-key",
    multimodalMaxAttachmentMb: 8,
    multimodalMaxTotalMb: 18,
    ...overrides
  };
}

const classification: ClassificationResult = {
  category: "secondary",
  summaryZh: "summary",
  reasonZh: "reason",
  actionItemsZh: []
};

test("AI test diagnostics use the resolved protocol and remove endpoint credentials and query values", () => {
  const queryValue = "not-visible-in-diagnostics";
  const diagnostics = buildAiTestDiagnostics(
    settings({
      baseUrl: `https://embedded-user:embedded-password@gateway.example.test/v1?key=${queryValue}`,
      protocol: "openai-responses",
      model: "gpt-5.6"
    }),
    classification
  );

  assert.deepEqual(diagnostics, {
    protocol: "openai-responses",
    endpoint: "https://gateway.example.test/v1/responses",
    model: "gpt-5.6",
    category: "secondary"
  });
  assert.equal(diagnostics.endpoint.includes(queryValue), false);
  assert.equal(diagnostics.endpoint.includes("embedded-user"), false);
  assert.equal(diagnostics.endpoint.includes("embedded-password"), false);
});

test("AI test requests retain primary and multimodal saved keys independently when fields are blank", () => {
  const saved = settings({ apiKey: "saved-primary-key", multimodalApiKey: "saved-vision-key" });
  const submitted = settings({ apiKey: "   ", multimodalApiKey: "" });
  const resolved = withSavedAiTestKeys(submitted, saved);

  assert.equal(resolved.apiKey === saved.apiKey, true);
  assert.equal(resolved.multimodalApiKey === saved.multimodalApiKey, true);
});
