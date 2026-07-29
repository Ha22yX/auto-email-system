import assert from "node:assert/strict";
import test from "node:test";
import { buildContextTokenUpdatedMessage } from "./manager";

test("buildContextTokenUpdatedMessage confirms refreshed WeChat notification session", () => {
  const message = buildContextTokenUpdatedMessage("2026-07-29T08:30:00.000Z");

  assert.match(message, /微信通知会话已刷新/);
  assert.match(message, /无需重新扫码/);
  assert.match(message, /重要邮件/);
  assert.match(message, /次重要邮件/);
  assert.match(message, /07\/29/);
});
