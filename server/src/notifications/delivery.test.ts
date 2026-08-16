import assert from "node:assert/strict";
import test from "node:test";
import { sendImageNotificationWithTextFallback } from "./delivery";

test("notification delivery sends the rendered image without a duplicate text message", async () => {
  const sent: string[] = [];
  const result = await sendImageNotificationWithTextFallback({
    renderImage: async () => Buffer.from("png"),
    sendImage: async () => { sent.push("image"); },
    sendText: async () => { sent.push("text"); }
  });
  assert.deepEqual(result, { mode: "image" });
  assert.deepEqual(sent, ["image"]);
});

test("notification delivery falls back to full text when card rendering or image upload fails", async () => {
  const sent: string[] = [];
  const result = await sendImageNotificationWithTextFallback({
    renderImage: async () => Buffer.from("png"),
    sendImage: async () => { throw new Error("media upload unavailable"); },
    sendText: async () => { sent.push("text"); }
  });
  assert.equal(result.mode, "text-fallback");
  assert.equal(result.imageError, "media upload unavailable");
  assert.deepEqual(sent, ["text"]);
});

test("notification delivery still fails when both image and text channels fail", async () => {
  await assert.rejects(sendImageNotificationWithTextFallback({
    renderImage: async () => { throw new Error("render failed"); },
    sendImage: async () => undefined,
    sendText: async () => { throw new Error("text failed"); }
  }), /text failed/);
});
