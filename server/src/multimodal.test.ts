import assert from "node:assert/strict";
import test from "node:test";
import { analyzeEmailAttachments } from "./multimodal";
import type { AiSettings, IncomingEmail } from "./types";

const settings: AiSettings = {
  providerName: "Test provider",
  providerPreset: "custom",
  baseUrl: "https://api.example.test/v1",
  apiKey: "primary-key",
  model: "text-model",
  temperature: 0.1,
  protocol: "openai-chat",
  multimodalEnabled: true,
  multimodalBaseUrl: "https://api.example.test/v1",
  multimodalModel: "",
  multimodalProtocol: "same",
  multimodalApiKey: "",
  multimodalMaxAttachmentMb: 8,
  multimodalMaxTotalMb: 18
};

const email: IncomingEmail = {
  mailboxId: "mailbox",
  externalUid: "uid",
  subject: "Invoice",
  fromAddress: "sender@example.test",
  originalText: "Please review the attached invoice.",
  attachments: [
    {
      id: "attachment",
      filename: "invoice.png",
      contentType: "image/png",
      size: 32,
      related: true,
      supportedForVision: true,
      contentBase64: "aW1hZ2U="
    }
  ]
};

function withMockFetch(callback: () => Promise<void>) {
  const originalFetch = globalThis.fetch;
  return callback().finally(() => {
    globalThis.fetch = originalFetch;
  });
}

test("multimodal analysis records the primary model when the multimodal model is blank", async () => {
  await withMockFetch(async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summaryZh: "图片中有账单",
                  reasonZh: "需要留档",
                  categoryHint: "secondary",
                  importantSignalsZh: ["付款金额"]
                })
              }
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    const analysis = await analyzeEmailAttachments(email, settings);
    assert.equal(analysis?.model, "text-model");
  });
});

test("multimodal provider failures use a provider-neutral error message and redact keys", async () => {
  await withMockFetch(async () => {
    globalThis.fetch = async () => new Response("request failed for primary-key", { status: 502 });

    await assert.rejects(
      analyzeEmailAttachments(email, settings),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /^多模态 AI 请求失败 502:/);
        assert.equal(error.message.includes("GLM-5V-Turbo"), false);
        assert.equal(error.message.includes("primary-key"), false);
        return true;
      }
    );
  });
});

test("multimodal non-JSON replies use a provider-neutral error message", async () => {
  await withMockFetch(async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "not JSON" } }] }), { status: 200 });

    await assert.rejects(
      analyzeEmailAttachments(email, settings),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /^多模态 AI 返回内容不是 JSON:/);
        assert.equal(error.message.includes("GLM-5V-Turbo"), false);
        return true;
      }
    );
  });
});
