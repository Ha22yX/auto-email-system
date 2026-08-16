import assert from "node:assert/strict";
import test from "node:test";
import { QqManager } from "./manager";
import type { QqDispatchEvent, QqGatewayStatus } from "./types";
import type { QqBotBinding, QqBotConfig } from "../types";

function config(overrides: Partial<QqBotConfig> = {}): QqBotConfig {
  return {
    appId: "1900000000",
    encryptedAppSecret: "v1:fake",
    enabled: true,
    quoteImageMarksRead: true,
  notifyCategories: { important: true, secondary: true, ignore: false },
    ...overrides
  };
}

function binding(): QqBotBinding {
  return {
    id: "primary",
    userOpenId: "abcdefgh12345678",
    friendshipStatus: "friend",
    proactiveStatus: "enabled",
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z"
  };
}

function harness(overrides: { config?: QqBotConfig; currentBinding?: QqBotBinding } = {}) {
  let currentBinding = overrides.currentBinding;
  let dispatchListener: ((event: QqDispatchEvent) => void) | undefined;
  let gatewayStatus: QqGatewayStatus = { state: "stopped", reconnectAttempt: 0 };
  let starts = 0;
  let stops = 0;
  const handled: QqDispatchEvent[] = [];
  const sent: string[] = [];
  const references: unknown[] = [];
  const actions: unknown[] = [];
  const statuses: unknown[] = [];
  let bindingReady = 0;
  const manager = new QqManager({
    readConfig: () => overrides.config ?? config(),
    gateway: {
      async start() {
        starts += 1;
        gatewayStatus = { state: "online", reconnectAttempt: 0 };
      },
      async stop() {
        stops += 1;
        gatewayStatus = { state: "stopped", reconnectAttempt: 0 };
      },
      status: () => gatewayStatus,
      onDispatch(listener) {
        dispatchListener = listener;
        return () => {
          dispatchListener = undefined;
        };
      }
    },
    bindingService: {
      readBinding: () => currentBinding,
      readChallenge: () => undefined,
      createBindingCode: () => ({ code: "ABC234", expiresAt: "2026-08-16T00:10:00.000Z" }),
      async handleDispatchEvent(event) {
        handled.push(event);
        currentBinding = binding();
        return { kind: "bound" as const };
      }
    },
    client: {
      async sendDirectMessage(input) {
        sent.push(input.userOpenId);
        return { messageId: "test-message" };
      },
      async sendDirectImage(input) {
        sent.push(input.userOpenId);
        actions.push({ kind: "image-input", input });
        return { messageId: "test-image", refIndex: "REFIDX_TEST_IMAGE" };
      },
      async acknowledgeInteraction() {}
    },
    recordMessageReference: (input) => {
      references.push(input);
      return { ...input, createdAt: "2026-08-16T00:00:00.000Z" };
    },
    createReadAction: (input) => {
      const action = { ...input, token: "a".repeat(32), createdAt: "2026-08-16T00:00:00.000Z" };
      actions.push({ kind: "created", action });
      return action;
    },
    finalizeReadAction: (token, input) => {
      actions.push({ kind: "finalized", token, input });
    },
    deleteReadAction: (token) => {
      actions.push({ kind: "deleted", token });
    },
    onStatus: (status) => statuses.push(status),
    onBindingReady: () => {
      bindingReady += 1;
    }
  });
  return {
    manager,
    handled,
    sent,
    references,
    actions,
    statuses,
    emit(event: QqDispatchEvent) {
      dispatchListener?.(event);
    },
    get starts() {
      return starts;
    },
    get stops() {
      return stops;
    },
    get bindingReady() {
      return bindingReady;
    }
  };
}

test("disabled or unconfigured QQ settings do not start the Gateway", async () => {
  const disabled = harness({ config: config({ enabled: false }) });
  await disabled.manager.start();
  assert.equal(disabled.starts, 0);

  const unconfigured = harness({ config: config({ encryptedAppSecret: "" }) });
  await unconfigured.manager.start();
  assert.equal(unconfigured.starts, 0);
  assert.equal(unconfigured.manager.status().configured, false);
});

test("enabled settings start one Gateway and forward dispatches to binding", async () => {
  const target = harness();
  await target.manager.start();
  await target.manager.start();
  assert.equal(target.starts, 1);

  target.emit({ id: "event-1", type: "C2C_MESSAGE_CREATE", sequence: 1, data: {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(target.handled.length, 1);
  assert.equal(target.bindingReady, 1);
  assert.equal(target.statuses.length > 0, true);
});

test("public status masks the bound user openid", () => {
  const target = harness({ currentBinding: binding() });
  const status = target.manager.status();
  assert.equal(status.bound, true);
  assert.equal(status.maskedRecipient, "abcd...5678");
  assert.equal(JSON.stringify(status).includes("abcdefgh12345678"), false);
});

test("rebind creates a challenge without deleting the existing recipient", async () => {
  const target = harness({ currentBinding: binding() });
  const result = await target.manager.rebind();
  assert.deepEqual(result, { code: "ABC234", expiresAt: "2026-08-16T00:10:00.000Z" });
  assert.equal(target.manager.status().bound, true);
  assert.equal(target.starts, 1);
});

test("test notification targets the stored openid and stop is idempotent", async () => {
  const target = harness({ currentBinding: binding() });
  await target.manager.testNotification();
  assert.deepEqual(target.sent, ["abcdefgh12345678"]);
  await target.manager.stop();
  await target.manager.stop();
  assert.equal(target.stops, 1);
});


test("sent QQ mail images persist message and ref-index mappings", async () => {
  const target = harness({ currentBinding: binding() });
  const result = await target.manager.sendImageNotification(Buffer.from("mail-card"), "email-42");
  assert.deepEqual(result, { messageId: "test-image", refIndex: "REFIDX_TEST_IMAGE" });
  assert.deepEqual(target.references, [{
    emailId: "email-42",
    userOpenId: "abcdefgh12345678",
    messageId: "test-image",
    refIndex: "REFIDX_TEST_IMAGE"
  }]);
  assert.deepEqual(target.actions, [
    {
      kind: "created",
      action: {
        emailId: "email-42",
        userOpenId: "abcdefgh12345678",
        token: "a".repeat(32),
        createdAt: "2026-08-16T00:00:00.000Z"
      }
    },
    {
      kind: "image-input",
      input: {
        userOpenId: "abcdefgh12345678",
        image: Buffer.from("mail-card"),
        fileName: "mail-summary.png",
        readActionToken: "a".repeat(32)
      }
    },
    {
      kind: "finalized",
      token: "a".repeat(32),
      input: { messageId: "test-image", refIndex: "REFIDX_TEST_IMAGE" }
    }
  ]);
});