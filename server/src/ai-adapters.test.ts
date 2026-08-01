import assert from "node:assert/strict";
import test from "node:test";
import { buildProviderRequest, extractProviderText } from "./ai-adapters";

const image = {
  filename: "invoice.png",
  contentType: "image/png",
  contentBase64: "aW1hZ2U="
};

const pdf = {
  filename: "statement.pdf",
  contentType: "application/pdf",
  contentBase64: "cGRm"
};

function requestFor(protocol: "openai-chat" | "openai-responses" | "anthropic" | "gemini") {
  return buildProviderRequest({
    protocol,
    url: "https://api.example.test/v1",
    apiKey: "adapter-test-key",
    model: "test-model",
    temperature: 0.2,
    systemPrompt: "system instruction",
    userPrompt: "user prompt",
    attachments: [image, pdf]
  });
}

function bodyOf(init: RequestInit) {
  assert.equal(typeof init.body, "string");
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

function headersOf(init: RequestInit) {
  return init.headers as Record<string, string>;
}

test("builds an OpenAI Chat request with JSON output and data URL attachments", () => {
  const { url, init } = requestFor("openai-chat");
  const body = bodyOf(init);

  assert.equal(url, "https://api.example.test/v1");
  assert.deepEqual(headersOf(init), {
    Authorization: "Bearer adapter-test-key",
    "Content-Type": "application/json"
  });
  assert.deepEqual(body, {
    model: "test-model",
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "system instruction" },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
          {
            type: "file",
            file: {
              filename: "statement.pdf",
              file_data: "data:application/pdf;base64,cGRm"
            }
          },
          { type: "text", text: "user prompt" }
        ]
      }
    ]
  });
});

test("builds an OpenAI Responses request with typed input and JSON output", () => {
  const { url, init } = requestFor("openai-responses");
  const body = bodyOf(init);

  assert.equal(url, "https://api.example.test/v1");
  assert.deepEqual(headersOf(init), {
    Authorization: "Bearer adapter-test-key",
    "Content-Type": "application/json"
  });
  assert.deepEqual(body, {
    model: "test-model",
    temperature: 0.2,
    instructions: "system instruction",
    text: { format: { type: "json_object" } },
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "user prompt" },
          { type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" },
          {
            type: "input_file",
            filename: "statement.pdf",
            file_data: "data:application/pdf;base64,cGRm"
          }
        ]
      }
    ]
  });
});

test("builds an Anthropic Messages request with base64 image and PDF blocks", () => {
  const { url, init } = requestFor("anthropic");
  const body = bodyOf(init);

  assert.equal(url, "https://api.example.test/v1");
  assert.deepEqual(headersOf(init), {
    "x-api-key": "adapter-test-key",
    "anthropic-version": "2023-06-01",
    "Content-Type": "application/json"
  });
  assert.deepEqual(body, {
    model: "test-model",
    max_tokens: 1200,
    temperature: 0.2,
    system: "system instruction",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "user prompt" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: "cGRm" }
          }
        ]
      }
    ]
  });
});

test("builds a Gemini request with system instructions and inline media", () => {
  const { url, init } = requestFor("gemini");
  const body = bodyOf(init);

  assert.equal(url, "https://api.example.test/v1");
  assert.deepEqual(headersOf(init), {
    "x-goog-api-key": "adapter-test-key",
    "Content-Type": "application/json"
  });
  assert.deepEqual(body, {
    generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
    systemInstruction: { parts: [{ text: "system instruction" }] },
    contents: [
      {
        role: "user",
        parts: [
          { text: "user prompt" },
          { inline_data: { mime_type: "image/png", data: "aW1hZ2U=" } },
          { inline_data: { mime_type: "application/pdf", data: "cGRm" } }
        ]
      }
    ]
  });
});

test("omits temperature in provider requests for GPT-5.6 and Claude 5", () => {
  const openAi = buildProviderRequest({
    protocol: "openai-chat",
    url: "https://api.example.test/v1/chat/completions",
    apiKey: "adapter-test-key",
    model: "gpt-5.6",
    temperature: 0.2,
    systemPrompt: "system",
    userPrompt: "user"
  });
  const anthropic = buildProviderRequest({
    protocol: "anthropic",
    url: "https://api.example.test/v1/messages",
    apiKey: "adapter-test-key",
    model: "claude-sonnet-5",
    temperature: 0.2,
    systemPrompt: "system",
    userPrompt: "user"
  });

  assert.equal("temperature" in bodyOf(openAi.init), false);
  assert.equal("temperature" in bodyOf(anthropic.init), false);
});

test("extracts text from every supported provider response shape", () => {
  assert.equal(
    extractProviderText("openai-chat", {
      choices: [{ message: { content: [{ text: "chat one" }, { text: "chat two" }] } }]
    }),
    "chat one\nchat two"
  );
  assert.equal(
    extractProviderText("openai-responses", { output_text: "responses top level" }),
    "responses top level"
  );
  assert.equal(
    extractProviderText("openai-responses", {
      output: [{ content: [{ text: "responses one" }, { output_text: "responses two" }] }]
    }),
    "responses one\nresponses two"
  );
  assert.equal(
    extractProviderText("anthropic", {
      content: [{ type: "thinking", text: "ignore" }, { type: "text", text: "anthropic text" }]
    }),
    "anthropic text"
  );
  assert.equal(
    extractProviderText("gemini", {
      candidates: [{ content: { parts: [{ text: "gemini one" }, { text: "gemini two" }] } }]
    }),
    "gemini one\ngemini two"
  );
});

test("concatenates string and text-part content from every OpenAI Chat choice", () => {
  assert.equal(
    extractProviderText("openai-chat", {
      choices: [
        { message: { content: "first choice" } },
        { message: { content: [{ text: "second choice" }, { type: "refusal" }] } },
        { message: { content: "third choice" } }
      ]
    }),
    "first choice\nsecond choice\nthird choice"
  );
});
