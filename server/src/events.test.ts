import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeAppEventPayload } from "./events";

test("SSE payload sanitization removes credentials and full QQ identifiers recursively", () => {
  const payload = sanitizeAppEventPayload({
    state: "online",
    maskedRecipient: "abcd...5678",
    appSecret: "secret",
    access_token: "token",
    nested: {
      user_openid: "abcdefgh12345678",
      codeHash: "hash",
      salt: "salt",
      pendingCount: 2
    }
  });
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes("secret"), false);
  assert.equal(serialized.includes("abcdefgh12345678"), false);
  assert.equal(serialized.includes("hash"), false);
  assert.equal(serialized.includes("salt"), false);
  assert.equal((payload as Record<string, unknown>).maskedRecipient, "abcd...5678");
  assert.match(serialized, /pendingCount/);
});
