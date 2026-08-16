import assert from "node:assert/strict";
import test from "node:test";
import type { ProcessedEmail, QqBotBinding, QqBotConfig, QqNotificationReference } from "../types";
import { QqQuoteReadService, parseQqQuoteReference } from "./quote-read";
import type { QqDispatchEvent, QqDirectMessageInput } from "./types";

const USER_OPEN_ID = "bound-user-openid";

function config(enabled = true): QqBotConfig {
  return {
    appId: "1900000000",
    encryptedAppSecret: "v1:test",
    enabled: true,
    quoteImageMarksRead: enabled,
    notifyCategories: { important: true, secondary: true, ignore: false }
  };
}

function binding(): QqBotBinding {
  return {
    id: "primary",
    userOpenId: USER_OPEN_ID,
    friendshipStatus: "friend",
    proactiveStatus: "enabled",
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:00.000Z"
  };
}

function email(panelRead = false): ProcessedEmail {
  return {
    id: "mail-1",
    mailboxId: "mailbox-1",
    externalUid: "uid-1",
    subject: "GitHub 身份验证码",
    processedAt: "2026-08-17T00:00:00.000Z",
    category: "important",
    summaryZh: "验证码邮件",
    reasonZh: "需要查看",
    actionItemsZh: [],
    originalText: "code",
    panelRead,
    readMarked: true
  };
}

function quoteEvent(data: Record<string, unknown>): QqDispatchEvent {
  return {
    id: "gateway-event-1",
    type: "C2C_MESSAGE_CREATE",
    sequence: 1,
    data: {
      id: "incoming-message-1",
      author: { user_openid: USER_OPEN_ID },
      content: "",
      ...data
    }
  };
}

test("parses QQ quote references from legacy ext and new msg_elements payloads", () => {
  assert.deepEqual(parseQqQuoteReference(quoteEvent({
    message_scene: { ext: ["msg_idx=REFIDX_CURRENT", "ref_msg_idx=REFIDX_MAIL"] }
  })), { refIndex: "REFIDX_MAIL" });

  assert.deepEqual(parseQqQuoteReference(quoteEvent({
    message_type: 103,
    msg_elements: [{ msg_idx: "REFIDX_NEW_CLIENT", content: "" }]
  })), { refIndex: "REFIDX_NEW_CLIENT" });

  assert.deepEqual(parseQqQuoteReference(quoteEvent({
    message_reference: { message_id: "outbound-message-id" }
  })), { messageId: "outbound-message-id" });
});

test("bound QQ user quoting a known mail image marks it read and receives confirmation", async () => {
  let current = email(false);
  const marked: string[] = [];
  const sent: QqDirectMessageInput[] = [];
  const reference: QqNotificationReference = {
    emailId: current.id,
    userOpenId: USER_OPEN_ID,
    refIndex: "REFIDX_MAIL",
    createdAt: "2026-08-17T00:00:00.000Z"
  };
  const service = new QqQuoteReadService({
    readConfig: () => config(),
    readBinding: binding,
    findReference: () => reference,
    readEmail: () => current,
    markPanelRead: (id) => {
      marked.push(id);
      current = { ...current, panelRead: true, panelReadAt: "2026-08-17T00:01:00.000Z" };
      return current;
    },
    client: {
      async sendDirectMessage(input) {
        sent.push(input);
        return { messageId: "confirmation" };
      }
    }
  });

  const result = await service.handleDispatchEvent(quoteEvent({
    message_scene: { ext: ["ref_msg_idx=REFIDX_MAIL"] }
  }));

  assert.deepEqual(result, { kind: "marked-read", emailId: "mail-1" });
  assert.deepEqual(marked, ["mail-1"]);
  assert.equal(sent[0].userOpenId, USER_OPEN_ID);
  assert.equal(sent[0].msgId, "incoming-message-1");
  assert.match(sent[0].content, /已标记为系统已读/);
  assert.match(sent[0].content, /GitHub 身份验证码/);
});

test("disabled setting and unbound senders cannot change panel read state", async () => {
  let marks = 0;
  const base = {
    readBinding: binding,
    findReference: () => ({
      emailId: "mail-1",
      userOpenId: USER_OPEN_ID,
      refIndex: "REFIDX_MAIL",
      createdAt: "2026-08-17T00:00:00.000Z"
    }),
    readEmail: () => email(false),
    markPanelRead: () => {
      marks += 1;
      return email(true);
    },
    client: { async sendDirectMessage() { return {}; } }
  };

  const disabled = new QqQuoteReadService({ ...base, readConfig: () => config(false) });
  assert.equal((await disabled.handleDispatchEvent(quoteEvent({
    message_scene: { ext: ["ref_msg_idx=REFIDX_MAIL"] }
  }))).kind, "disabled");

  const unauthorized = new QqQuoteReadService({ ...base, readConfig: () => config(true) });
  const event = quoteEvent({ message_scene: { ext: ["ref_msg_idx=REFIDX_MAIL"] } });
  event.data.author = { user_openid: "different-user" };
  assert.equal((await unauthorized.handleDispatchEvent(event)).kind, "unauthorized");
  assert.equal(marks, 0);
});

test("quoting an already-read email confirms without writing it again", async () => {
  let marks = 0;
  const sent: QqDirectMessageInput[] = [];
  const service = new QqQuoteReadService({
    readConfig: () => config(),
    readBinding: binding,
    findReference: () => ({
      emailId: "mail-1",
      userOpenId: USER_OPEN_ID,
      messageId: "outbound-message",
      createdAt: "2026-08-17T00:00:00.000Z"
    }),
    readEmail: () => email(true),
    markPanelRead: () => {
      marks += 1;
      return email(true);
    },
    client: {
      async sendDirectMessage(input) {
        sent.push(input);
        return {};
      }
    }
  });

  assert.equal((await service.handleDispatchEvent(quoteEvent({
    message_reference: { message_id: "outbound-message" }
  }))).kind, "already-read");
  assert.equal(marks, 0);
  assert.match(sent[0].content, /已经是系统已读/);
});