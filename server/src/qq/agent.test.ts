import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ProcessedEmail, QqBotBinding, QqBotConfig } from "../types";
import type { QqDirectMessageInput, QqDispatchEvent } from "./types";

process.env.DATA_DIR ??= path.join(tmpdir(), `auto-email-system-agent-test-${process.pid}`);
process.env.QQ_CREDENTIAL_ENCRYPTION_KEY ??= "test-only-qq-credential-encryption-key";

const { addProcessedEmail, getProcessedEmailById } = await import("../store");
const { QqAgentService } = await import("./agent");

const USER_OPEN_ID = "agent-bound-user";

const agentDefaults: QqBotConfig["agent"] = {
  enabled: true,
  requireConfirmation: true,
  maxResults: 6,
  permissions: {
    readMail: true,
    manageReadState: true,
    manageNotifications: true,
    runProcessing: true,
    checkMailboxes: true,
    reclassifyMail: true
  }
};

function config(agent: QqBotConfig["agent"] = agentDefaults): QqBotConfig {
  return {
    appId: "1900000000",
    encryptedAppSecret: "v1:test",
    enabled: false,
    quoteImageMarksRead: true,
    notifyCategories: { important: true, secondary: true, ignore: false },
    agent
  };
}

function binding(): QqBotBinding {
  return {
    id: "primary",
    userOpenId: USER_OPEN_ID,
    friendshipStatus: "friend",
    proactiveStatus: "enabled",
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z"
  };
}

function event(content: string, id: string): QqDispatchEvent {
  return {
    id,
    type: "C2C_MESSAGE_CREATE",
    sequence: Number(id.replace(/\D/g, "")) || 1,
    data: {
      id: `message-${id}`,
      author: { user_openid: USER_OPEN_ID },
      content
    }
  };
}

function email(input: { id: string; subject: string; receivedAt: string; panelRead?: boolean }): ProcessedEmail {
  return {
    id: input.id,
    mailboxId: `agent-mailbox-${process.pid}`,
    externalUid: input.id,
    subject: input.subject,
    fromName: "Grab",
    fromAddress: "no-reply@example.com",
    receivedAt: input.receivedAt,
    processedAt: input.receivedAt,
    category: "important",
    summaryZh: "测试邮件摘要",
    reasonZh: "用于 QQ Agent 测试",
    actionItemsZh: ["查看账单"],
    originalText: "This is a test receipt.",
    panelRead: input.panelRead ?? false,
    readMarked: true
  };
}

function harness(options: { config?: QqBotConfig; currentBinding?: QqBotBinding } = {}) {
  const sent: QqDirectMessageInput[] = [];
  const service = new QqAgentService({
    readConfig: () => options.config ?? config(),
    readBinding: () => options.currentBinding ?? binding(),
    client: {
      async sendDirectMessage(input) {
        sent.push(input);
        return { messageId: `reply-${sent.length}` };
      }
    },
    now: () => Date.parse("2026-08-31T12:00:00.000Z")
  });
  return { service, sent };
}

test("disabled QQ Agent ignores bound direct messages", async () => {
  const target = harness({ config: config({ ...agentDefaults, enabled: false }) });
  const result = await target.service.handleDispatchEvent(event("最近邮件", "disabled-1"));

  assert.deepEqual(result, { kind: "disabled" });
  assert.equal(target.sent.length, 0);
});

test("enabled QQ Agent lists recent mail for the bound user", async () => {
  const suffix = `${process.pid}-${Date.now()}`;
  addProcessedEmail(email({
    id: `agent-old-${suffix}`,
    subject: `Old receipt ${suffix}`,
    receivedAt: "2026-08-31T08:00:00.000Z"
  }));
  addProcessedEmail(email({
    id: `agent-new-${suffix}`,
    subject: `Your Grab E-Receipt ${suffix}`,
    receivedAt: "2026-08-31T09:00:00.000Z"
  }));

  const target = harness();
  const result = await target.service.handleDispatchEvent(event("最新邮件", `list-${suffix}`));

  assert.deepEqual(result, { kind: "handled" });
  assert.equal(target.sent.length, 1);
  assert.match(target.sent[0].content, /最近邮件/);
  assert.match(target.sent[0].content, /Your Grab E-Receipt/);
  assert.equal(target.sent[0].msgId, `message-list-${suffix}`);
});

test("write tools require confirmation before changing mail state", async () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const emailId = `agent-confirm-${suffix}`;
  addProcessedEmail(email({
    id: emailId,
    subject: `Confirm receipt ${suffix}`,
    receivedAt: "2026-08-31T10:00:00.000Z"
  }));

  const target = harness();
  await target.service.handleDispatchEvent(event(`搜索 ${suffix}`, `search-${suffix}`));
  await target.service.handleDispatchEvent(event("把第 1 封标记已读", `mark-${suffix}`));

  assert.equal(getProcessedEmailById(emailId)?.panelRead, false);
  assert.match(target.sent.at(-1)?.content ?? "", /回复“确认”执行/);

  await target.service.handleDispatchEvent(event("确认", `confirm-${suffix}`));
  assert.equal(getProcessedEmailById(emailId)?.panelRead, true);
  assert.match(target.sent.at(-1)?.content ?? "", /标记为系统已读/);
});

test("disabled write permission blocks read-state changes", async () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const emailId = `agent-denied-${suffix}`;
  addProcessedEmail(email({
    id: emailId,
    subject: `Denied receipt ${suffix}`,
    receivedAt: "2026-08-31T11:00:00.000Z"
  }));

  const target = harness({
    config: config({
      ...agentDefaults,
      permissions: { ...agentDefaults.permissions, manageReadState: false }
    })
  });
  await target.service.handleDispatchEvent(event(`搜索 ${suffix}`, `denied-search-${suffix}`));
  await target.service.handleDispatchEvent(event("把第 1 封标记已读", `denied-mark-${suffix}`));

  assert.equal(getProcessedEmailById(emailId)?.panelRead, false);
  assert.match(target.sent.at(-1)?.content ?? "", /没有开启权限/);
});
