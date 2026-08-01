import assert from "node:assert/strict";
import test from "node:test";
import { AI_PROVIDER_PRESETS, applyAiPreset } from "./ai-presets";
import type { AiSettings } from "./types";

const current: AiSettings = {
  providerName: "Existing provider",
  providerPreset: "custom",
  baseUrl: "https://existing.example/v1",
  apiKey: "primary-secret",
  model: "existing-model",
  temperature: 0.1,
  protocol: "auto",
  multimodalEnabled: true,
  multimodalBaseUrl: "https://vision.example/v1",
  multimodalModel: "vision-model",
  multimodalProtocol: "auto",
  multimodalApiKey: "vision-secret",
  multimodalMaxAttachmentMb: 8,
  multimodalMaxTotalMb: 18
};

test("provider presets expose the supported API choices", () => {
  assert.deepEqual(
    AI_PROVIDER_PRESETS.map((preset) => preset.id),
    ["openai", "anthropic", "gemini", "zhipu", "deepseek", "qwen", "moonshot", "openrouter", "custom"]
  );
});

test("provider presets keep their documented protocol, endpoint, and model defaults", () => {
  const expected = {
    anthropic: ["https://api.anthropic.com", "anthropic", "claude-sonnet-5", "same", "claude-sonnet-5"],
    gemini: [
      "https://generativelanguage.googleapis.com/v1beta",
      "gemini",
      "gemini-3.6-flash",
      "same",
      "gemini-3.6-flash"
    ],
    moonshot: ["https://api.moonshot.cn/v1", "openai-chat", "kimi-k2.5", "same", "kimi-k2.5"],
    openrouter: ["https://openrouter.ai/api/v1", "openai-chat", "~openai/gpt-latest", "same", "~openai/gpt-latest"]
  } as const;

  for (const [id, values] of Object.entries(expected)) {
    const settings = applyAiPreset(current, id);
    assert.deepEqual(
      [settings.baseUrl, settings.protocol, settings.model, settings.multimodalProtocol, settings.multimodalModel],
      values
    );
  }
});

test("OpenAI preset fills primary and same-protocol multimodal defaults without replacing keys", () => {
  const settings = applyAiPreset(current, "openai");

  assert.equal(settings.providerName, "OpenAI");
  assert.equal(settings.baseUrl, "https://api.openai.com/v1");
  assert.equal(settings.protocol, "openai-responses");
  assert.equal(settings.model, "gpt-5.6");
  assert.equal(settings.multimodalProtocol, "same");
  assert.equal(settings.multimodalBaseUrl, "https://api.openai.com/v1");
  assert.equal(settings.multimodalModel, "gpt-5.6");
  assert.equal(settings.apiKey, "primary-secret");
  assert.equal(settings.multimodalApiKey, "vision-secret");
});

test("Zhipu preset keeps its independent Anthropic and OpenAI-compatible endpoints", () => {
  const settings = applyAiPreset(current, "zhipu");

  assert.equal(settings.protocol, "anthropic");
  assert.equal(settings.baseUrl, "https://open.bigmodel.cn/api/anthropic");
  assert.equal(settings.model, "glm-5.2");
  assert.equal(settings.multimodalProtocol, "openai-chat");
  assert.equal(settings.multimodalBaseUrl, "https://open.bigmodel.cn/api/paas/v4/chat/completions");
  assert.equal(settings.multimodalModel, "glm-5v-turbo");
});

test("DeepSeek preset disables multimodal analysis while Qwen provides its vision model", () => {
  const deepseek = applyAiPreset(current, "deepseek");
  const qwen = applyAiPreset(current, "qwen");

  assert.equal(deepseek.multimodalEnabled, false);
  assert.equal(deepseek.model, "deepseek-v4-flash");
  assert.equal(qwen.multimodalEnabled, true);
  assert.equal(qwen.multimodalProtocol, "same");
  assert.equal(qwen.multimodalModel, "qwen3-vl-plus");
});

test("Custom preset preserves every existing setting", () => {
  assert.deepEqual(applyAiPreset(current, "custom"), current);
});

test("all non-custom presets preserve both API keys", () => {
  for (const preset of AI_PROVIDER_PRESETS) {
    if (preset.id === "custom") continue;
    const settings = applyAiPreset(current, preset.id);
    assert.equal(settings.apiKey, current.apiKey);
    assert.equal(settings.multimodalApiKey, current.multimodalApiKey);
  }
});
