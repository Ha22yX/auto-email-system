import assert from "node:assert/strict";
import test from "node:test";
import type { ProcessedEmail, QqBotBinding, QqEmailReadAction } from "../types";
import { QqButtonReadService, parseQqMailReadInteraction } from "./button-read";
import type { QqDirectMessageInput, QqDispatchEvent } from "./types";

const USER_OPEN_ID = "bound-user-openid";
const TOKEN = "a".repeat(32);

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

function action(): QqEmailReadAction {
  return {
    token: TOKEN,
    emailId: "mail-1",
    userOpenId: USER_OPEN_ID,
    messageId: "mail-image-message",
    refIndex: "REFIDX_MAIL",
    createdAt: "2026-08-17T00:00:00.000Z"
  };
}

function interaction(userOpenId = USER_OPEN_ID): QqDispatchEvent {
  return {
    id: "interaction-1",
    type: "INTERACTION_CREATE",
    sequence: 7,
    data: {
      id: "interaction-1",
      user_openid: userOpenId,
      data: {
        type: 11,
        resolved: {
          button_id: "mail-read",
          button_data: `mail-read:${TOKEN}`,
          user_id: userOpenId,
          message_id: "mail-image-message"
        }
      }
    }
  };
}

test("parses only valid mail-read callback interactions", () => {
  assert.deepEqual(parseQqMailReadInteraction(interaction()), {
    interactionId: "interaction-1",
    token: TOKEN
  });
  const unrelated = interaction();
  (unrelated.data.data as { resolved: { button_data: string } }).resolved.button_data = "other-action";
  assert.equal(parseQqMailReadInteraction(unrelated), undefined);
});

test("accepts the bound user id from the interaction resolved payload", async () => {
  const event = interaction();
  delete event.data.user_openid;
  let marked = false;
  const service = new QqButtonReadService({
    readBinding: binding,
    findAction: () => action(),
    readEmail: () => email(false),
    markPanelRead: (_id, panelRead) => {
      marked = panelRead;
      return email(panelRead);
    },
    markActionUsed: () => "",
    client: {
      async acknowledgeInteraction() {},
      async sendDirectMessage() {
        return {};
      }
    }
  });

  assert.equal((await service.handleDispatchEvent(event)).kind, "marked-read");
  assert.equal(marked, true);
});

test("button click ACKs, marks the email read, and references the original image", async () => {
  let current = email(false);
  const acknowledgements: string[] = [];
  const marks: string[] = [];
  const used: string[] = [];
  const sent: QqDirectMessageInput[] = [];
  const service = new QqButtonReadService({
    readBinding: binding,
    findAction: () => action(),
    readEmail: () => current,
    markPanelRead: (id) => {
      marks.push(id);
      current = { ...current, panelRead: true };
      return current;
    },
    markActionUsed: (token) => {
      used.push(token);
      return "2026-08-17T00:01:00.000Z";
    },
    client: {
      async acknowledgeInteraction(id) {
        acknowledgements.push(id);
      },
      async sendDirectMessage(input) {
        sent.push(input);
        return { messageId: "confirmation-message" };
      }
    }
  });

  assert.deepEqual(await service.handleDispatchEvent(interaction()), {
    kind: "marked-read",
    emailId: "mail-1",
    acknowledgementFailed: false,
    confirmationFailed: false,
    confirmationReferenced: true
  });
  assert.deepEqual(acknowledgements, ["interaction-1"]);
  assert.deepEqual(marks, ["mail-1"]);
  assert.deepEqual(used, [TOKEN]);
  assert.equal(sent[0].messageReferenceId, "mail-image-message");
  assert.match(sent[0].content, /已标记为系统已读/);
});

test("confirmation falls back to an unreferenced message when QQ rejects the quote", async () => {
  const sent: QqDirectMessageInput[] = [];
  const service = new QqButtonReadService({
    readBinding: binding,
    findAction: () => action(),
    readEmail: () => email(false),
    markPanelRead: () => email(true),
    markActionUsed: () => "",
    client: {
      async acknowledgeInteraction() {},
      async sendDirectMessage(input) {
        sent.push(input);
        if (input.messageReferenceId) throw new Error("reference not supported");
        return { messageId: "plain-confirmation" };
      }
    }
  });

  const result = await service.handleDispatchEvent(interaction());
  assert.equal(result.kind, "marked-read");
  assert.equal(result.confirmationFailed, false);
  assert.equal(result.confirmationReferenced, false);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].messageReferenceId, "mail-image-message");
  assert.equal(sent[1].messageReferenceId, undefined);
});

test("a different QQ user cannot use a captured button token", async () => {
  let marks = 0;
  let acknowledgements = 0;
  const service = new QqButtonReadService({
    readBinding: binding,
    findAction: () => action(),
    readEmail: () => email(false),
    markPanelRead: () => {
      marks += 1;
      return email(true);
    },
    markActionUsed: () => "",
    client: {
      async acknowledgeInteraction() {
        acknowledgements += 1;
      },
      async sendDirectMessage() {
        return {};
      }
    }
  });

  assert.equal((await service.handleDispatchEvent(interaction("different-user"))).kind, "unauthorized");
  assert.equal(acknowledgements, 1);
  assert.equal(marks, 0);
});
