import assert from "node:assert/strict";
import test from "node:test";
import { buildTemperaturePayload, resolveOpenAiChatUrl } from "./ai-request";

test("omits temperature for GPT-5.6 on the OpenAI API", () => {
  assert.deepEqual(
    buildTemperaturePayload("gpt-5.6", 0.1),
    {}
  );
});

test("omits temperature for named GPT-5.6 family variants", () => {
  assert.deepEqual(buildTemperaturePayload("gpt-5.6-sol", 0.1), {});
  assert.deepEqual(buildTemperaturePayload("gpt-5.6-terra", 0.1), {});
});

test("omits temperature for Claude 5 models but keeps it for older Claude models", () => {
  assert.deepEqual(buildTemperaturePayload("claude-sonnet-5", 0.1), {});
  assert.deepEqual(buildTemperaturePayload("claude-opus-5", 0.1), {});
  assert.deepEqual(buildTemperaturePayload("claude-3-7-sonnet", 0.1), { temperature: 0.1 });
});

test("keeps configured temperature for OpenAI-compatible GLM models", () => {
  assert.deepEqual(
    buildTemperaturePayload("glm-5.2", 0.1),
    { temperature: 0.1 }
  );
});

test("resolves an API root to the Chat Completions endpoint", () => {
  assert.equal(
    resolveOpenAiChatUrl("https://api.openai.com/v1"),
    "https://api.openai.com/v1/chat/completions"
  );
  assert.equal(
    resolveOpenAiChatUrl("https://api.openai.com/v1/chat/completions"),
    "https://api.openai.com/v1/chat/completions"
  );
});
