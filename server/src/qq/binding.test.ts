import assert from "node:assert/strict";
import test from "node:test";
import { QqApiError, type QqDispatchEvent } from "./types";
import {
  createQqBindingService,
  type QqBindingChallenge,
  type QqBindingStorage
} from "./binding";
import type { QqBotBinding } from "../types";

function event(type: string, data: Record<string, unknown>, id = `${type}-event`): QqDispatchEvent {
  return { id, type, sequence: 1, data };
}

function createHarness(nowValue = Date.parse("2026-08-16T00:00:00.000Z")) {
  let now = nowValue;
  let challenge: QqBindingChallenge | undefined;
  let binding: QqBotBinding | undefined = {
    id: "primary",
    userOpenId: "old-user",
    friendshipStatus: "friend",
    proactiveStatus: "enabled",
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z"
  };
  const events = new Set<string>();
  const sends: Array<{ userOpenId: string; content: string; msgId?: string }> = [];
  const storage: QqBindingStorage = {
    readChallenge: () => challenge,
    writeChallenge: (next) => {
      challenge = next;
    },
    consumeChallenge: (challengeId, nextBinding, consumedAt) => {
      if (!challenge || challenge.id !== challengeId || challenge.consumedAt || challenge.expiresAt <= consumedAt) {
        return undefined;
      }
      challenge = { ...challenge, consumedAt };
      const createdAt = binding?.createdAt ?? consumedAt;
      binding = { ...nextBinding, createdAt, updatedAt: consumedAt };
      return binding;
    },
    readBinding: () => binding,
    updateBinding: (patch, updatedAt) => {
      if (!binding) return undefined;
      binding = { ...binding, ...patch, updatedAt };
      return binding;
    },
    rememberEvent: (eventId) => {
      if (events.has(eventId)) return false;
      events.add(eventId);
      return true;
    }
  };
  const service = createQqBindingService({
    storage,
    client: {
      async sendDirectMessage(input) {
        sends.push(input);
        return { messageId: `sent-${sends.length}` };
      }
    },
    now: () => now,
    randomBytes: (size) => Buffer.alloc(size, 7),
    generateCode: () => "ABC234"
  });
  return {
    service,
    sends,
    storage,
    get challenge() {
      return challenge;
    },
    get binding() {
      return binding;
    },
    setNow(value: number) {
      now = value;
    }
  };
}

test("binding codes are hashed, single-use, and expire after ten minutes", () => {
  const harness = createHarness();
  const result = harness.service.createBindingCode();

  assert.equal(result.code, "ABC234");
  assert.equal(result.expiresAt, "2026-08-16T00:10:00.000Z");
  assert.equal(JSON.stringify(harness.challenge).includes("ABC234"), false);
  assert.match(harness.challenge?.codeHash ?? "", /^[a-f0-9]{64}$/);
  assert.match(harness.challenge?.salt ?? "", /^[a-f0-9]{32}$/);
});

test("an exact direct-chat code atomically rebinds and sends passive then proactive confirmation", async () => {
  const harness = createHarness();
  harness.service.createBindingCode();

  await harness.service.handleDispatchEvent(
    event("C2C_MESSAGE_CREATE", {
      id: "message-1",
      content: "  ABC234  ",
      author: { user_openid: "new-user" }
    })
  );

  assert.equal(harness.binding?.userOpenId, "new-user");
  assert.equal(harness.binding?.proactiveStatus, "enabled");
  assert.equal(harness.challenge?.consumedAt, "2026-08-16T00:00:00.000Z");
  assert.equal(harness.sends.length, 2);
  assert.equal(harness.sends[0].msgId, "message-1");
  assert.equal(harness.sends[1].msgId, undefined);
});

test("wrong, expired, duplicate, and ordinary messages never replace the existing binding", async () => {
  const harness = createHarness();
  harness.service.createBindingCode();

  await harness.service.handleDispatchEvent(
    event("C2C_MESSAGE_CREATE", { id: "wrong", content: "WRONG1", author: { user_openid: "attacker" } }, "event-wrong")
  );
  assert.equal(harness.binding?.userOpenId, "old-user");
  assert.equal(harness.sends.length, 0);

  harness.setNow(Date.parse("2026-08-16T00:11:00.000Z"));
  await harness.service.handleDispatchEvent(
    event("C2C_MESSAGE_CREATE", { id: "late", content: "ABC234", author: { user_openid: "late-user" } }, "event-late")
  );
  assert.equal(harness.binding?.userOpenId, "old-user");

  await harness.service.handleDispatchEvent(
    event("C2C_MESSAGE_CREATE", { id: "late", content: "ABC234", author: { user_openid: "late-user" } }, "event-late")
  );
  assert.equal(harness.sends.length, 0);
});

test("capability events update only the bound recipient", async () => {
  const harness = createHarness();

  await harness.service.handleDispatchEvent(event("C2C_MSG_REJECT", { openid: "old-user" }, "reject"));
  assert.equal(harness.binding?.proactiveStatus, "disabled");
  await harness.service.handleDispatchEvent(event("C2C_MSG_RECEIVE", { openid: "old-user" }, "receive"));
  assert.equal(harness.binding?.proactiveStatus, "enabled");
  await harness.service.handleDispatchEvent(event("FRIEND_DEL", { openid: "old-user" }, "friend-del"));
  assert.equal(harness.binding?.friendshipStatus, "removed");
  await harness.service.handleDispatchEvent(event("FRIEND_ADD", { openid: "old-user" }, "friend-add"));
  assert.equal(harness.binding?.friendshipStatus, "friend");

  await harness.service.handleDispatchEvent(event("C2C_MSG_REJECT", { openid: "someone-else" }, "other"));
  assert.equal(harness.binding?.proactiveStatus, "disabled");
});

test("a rejected proactive confirmation keeps the binding and records disabled capability", async () => {
  const harness = createHarness();
  harness.service.createBindingCode();
  let calls = 0;
  const service = createQqBindingService({
    storage: harness.storage,
    client: {
      async sendDirectMessage() {
        calls += 1;
        if (calls === 2) throw new QqApiError({ kind: "permission", status: 403, code: "11253" });
        return {};
      }
    },
    now: () => Date.parse("2026-08-16T00:00:00.000Z")
  });

  await service.handleDispatchEvent(
    event("C2C_MESSAGE_CREATE", {
      id: "message-2",
      content: "ABC234",
      author: { user_openid: "new-user" }
    }, "bind-rejected")
  );

  assert.equal(harness.binding?.userOpenId, "new-user");
  assert.equal(harness.binding?.proactiveStatus, "disabled");
});
