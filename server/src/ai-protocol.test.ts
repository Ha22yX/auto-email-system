import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveAiEndpoint,
  resolveAiProtocol,
  resolveAnthropicMessagesUrl,
  resolveGeminiGenerateContentUrl,
  resolveOpenAiChatUrl,
  resolveOpenAiResponsesUrl
} from "./ai-protocol";

test("infers Anthropic from legacy GLM and Messages API URLs", () => {
  assert.equal(
    resolveAiProtocol({ baseUrl: "https://open.bigmodel.cn/api/anthropic" }, "text"),
    "anthropic"
  );
  assert.equal(
    resolveAiProtocol({ baseUrl: "https://api.anthropic.com/v1/messages" }, "text"),
    "anthropic"
  );
});

test("infers Gemini from its host and complete generateContent URLs", () => {
  assert.equal(
    resolveAiProtocol({ baseUrl: "https://generativelanguage.googleapis.com/v1beta" }, "text"),
    "gemini"
  );
  assert.equal(
    resolveAiProtocol(
      { baseUrl: "https://gateway.example/v1beta/models/gemini-2.0-flash:generateContent" },
      "text"
    ),
    "gemini"
  );
});

test("infers Responses and otherwise defaults legacy settings to Chat Completions", () => {
  assert.equal(
    resolveAiProtocol({ baseUrl: "https://api.openai.com/v1/responses" }, "text"),
    "openai-responses"
  );
  assert.equal(
    resolveAiProtocol({ baseUrl: "https://api.openai.com/v1" }, "text"),
    "openai-chat"
  );
});

test("uses an explicit protocol and resolves same multimodal protocol from the primary settings", () => {
  assert.equal(
    resolveAiProtocol({ baseUrl: "https://api.openai.com/v1", protocol: "gemini" }, "text"),
    "gemini"
  );
  assert.equal(
    resolveAiProtocol(
      {
        baseUrl: "https://open.bigmodel.cn/api/anthropic",
        multimodalBaseUrl: "https://gateway.example/v1",
        multimodalProtocol: "same"
      },
      "multimodal"
    ),
    "anthropic"
  );
});

test("resolves OpenAI Chat and Responses roots without duplicating complete endpoints", () => {
  assert.equal(
    resolveOpenAiChatUrl("https://api.openai.com/v1"),
    "https://api.openai.com/v1/chat/completions"
  );
  assert.equal(
    resolveOpenAiChatUrl("https://api.openai.com/v1/chat/completions/"),
    "https://api.openai.com/v1/chat/completions"
  );
  assert.equal(
    resolveOpenAiResponsesUrl("https://api.openai.com/v1"),
    "https://api.openai.com/v1/responses"
  );
  assert.equal(
    resolveOpenAiResponsesUrl("https://api.openai.com/v1/responses/"),
    "https://api.openai.com/v1/responses"
  );
});

test("resolves Anthropic and Gemini roots without duplicating complete endpoints", () => {
  assert.equal(
    resolveAnthropicMessagesUrl("https://api.anthropic.com"),
    "https://api.anthropic.com/v1/messages"
  );
  assert.equal(
    resolveAnthropicMessagesUrl("https://api.anthropic.com/v1/messages/"),
    "https://api.anthropic.com/v1/messages"
  );
  assert.equal(
    resolveGeminiGenerateContentUrl("https://generativelanguage.googleapis.com/v1beta", "gemini-2.0-flash"),
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent"
  );
  assert.equal(
    resolveGeminiGenerateContentUrl(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent/",
      "gemini-2.5-pro"
    ),
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent"
  );
});

test("resolves a protocol-selected endpoint for text and multimodal settings", () => {
  assert.equal(
    resolveAiEndpoint(
      {
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-5.6",
        protocol: "openai-responses"
      },
      "text"
    ),
    "https://api.openai.com/v1/responses"
  );
  assert.equal(
    resolveAiEndpoint(
      {
        baseUrl: "https://api.openai.com/v1",
        multimodalBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
        multimodalModel: "gemini-2.0-flash",
        multimodalProtocol: "gemini"
      },
      "multimodal"
    ),
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent"
  );
});
