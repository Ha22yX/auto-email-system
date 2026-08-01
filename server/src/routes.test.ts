import assert from "node:assert/strict";
import test from "node:test";
import type { AiSettings, ClassificationResult } from "./types";

const { aiSchema, buildAiTestDiagnostics, withSavedAiTestKeys } = await import("./routes");

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

test("AI test diagnostics expose the provider without returning user-controlled endpoint paths or credentials", () => {
  const primaryKey = "primary/submitted-key";
  const multimodalKey = "multimodal-submitted-key";
  const lowerCaseEncodedPrimaryKey = encodeURIComponent(primaryKey).replaceAll("%2F", "%2f");
  const diagnostics = buildAiTestDiagnostics(
    settings({
      providerName: "Reviewed provider",
      apiKey: primaryKey,
      multimodalApiKey: multimodalKey,
      baseUrl: `https://${encodeURIComponent(primaryKey)}:${multimodalKey}@gateway.example.test/${lowerCaseEncodedPrimaryKey}/v1?key=${multimodalKey}`,
      protocol: "openai-responses",
      model: "gpt-5.6"
    }),
    classification
  );

  assert.deepEqual(diagnostics, {
    provider: "Reviewed provider",
    protocol: "openai-responses",
    endpoint: "https://gateway.example.test",
    model: "gpt-5.6",
    category: "secondary"
  });
  assert.equal(diagnostics.endpoint.includes(primaryKey), false);
  assert.equal(diagnostics.endpoint.includes(multimodalKey), false);
});

test("AI settings schema accepts an empty multimodal model for primary model fallback", () => {
  const parsed = aiSchema.parse(settings({ multimodalModel: "" }));
  assert.equal(parsed.multimodalModel, "");
});

test("AI test requests retain primary and multimodal saved keys independently when fields are blank", () => {
  const saved = settings({ apiKey: "saved-primary-key", multimodalApiKey: "saved-vision-key" });
  const submitted = settings({ apiKey: "   ", multimodalApiKey: "" });
  const resolved = withSavedAiTestKeys(submitted, saved);

  assert.equal(resolved.apiKey === saved.apiKey, true);
  assert.equal(resolved.multimodalApiKey === saved.multimodalApiKey, true);
});
