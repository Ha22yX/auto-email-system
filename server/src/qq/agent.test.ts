import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ProcessedEmail, QqBotBinding, QqBotConfig } from "../types";
import type { QqDirectImageInput, QqDirectMarkdownMessageInput, QqDirectMessageInput, QqDispatchEvent } from "./types";

process.env.DATA_DIR ??= path.join(tmpdir(), `auto-email-system-agent-test-${process.pid}`);
process.env.QQ_CREDENTIAL_ENCRYPTION_KEY ??= "test-only-qq-credential-encryption-key";

const { addProcessedEmail, findQqNotificationReference, getProcessedEmailById, updateAiSettings } = await import("../store");
const { QqAgentService } = await import("./agent");

const USER_OPEN_ID = "agent-bound-user";

const agentDefaults: QqBotConfig["agent"] = {
  enabled: true,
  requireConfirmation: true,
  maxResults: 6,
  permissions: {
    readMail: true,
    sendMailImages: true,
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

function binding(userOpenId = USER_OPEN_ID): QqBotBinding {
  return {
    id: "primary",
    userOpenId,
    friendshipStatus: "friend",
    proactiveStatus: "enabled",
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z"
  };
}

function event(content: string, id: string, userOpenId = USER_OPEN_ID): QqDispatchEvent {
  return {
    id,
    type: "C2C_MESSAGE_CREATE",
    sequence: Number(id.replace(/\D/g, "")) || 1,
    data: {
      id: `message-${id}`,
      author: { user_openid: userOpenId },
      content
    }
  };
}

function email(input: {
  id: string;
  subject: string;
  receivedAt: string;
  panelRead?: boolean;
  fromName?: string;
  fromAddress?: string;
  summaryZh?: string;
  originalText?: string;
  category?: ProcessedEmail["category"];
}): ProcessedEmail {
  return {
    id: input.id,
    mailboxId: `agent-mailbox-${process.pid}`,
    externalUid: input.id,
    subject: input.subject,
    fromName: input.fromName ?? "Grab",
    fromAddress: input.fromAddress ?? "no-reply@example.com",
    receivedAt: input.receivedAt,
    processedAt: input.receivedAt,
    category: input.category ?? "important",
    summaryZh: input.summaryZh ?? "测试邮件摘要",
    reasonZh: "用于 QQ Agent 测试",
    actionItemsZh: ["查看账单"],
    originalText: input.originalText ?? "This is a test receipt.",
    panelRead: input.panelRead ?? false,
    readMarked: true
  };
}

function harness(options: {
  config?: QqBotConfig;
  currentBinding?: QqBotBinding;
  fetch?: typeof fetch;
  markdown?: boolean;
  userOpenId?: string;
  renderEmailCard?: () => Promise<Buffer>;
} = {}) {
  const sent: QqDirectMessageInput[] = [];
  const sentMarkdown: QqDirectMarkdownMessageInput[] = [];
  const sentImages: QqDirectImageInput[] = [];
  const client = {
    async sendDirectMessage(input: QqDirectMessageInput) {
      sent.push(input);
      return { messageId: `reply-${sent.length}` };
    },
    async sendDirectImage(input: QqDirectImageInput) {
      sentImages.push(input);
      return { messageId: `image-reply-${sentImages.length}`, refIndex: `image-ref-${sentImages.length}` };
    },
    ...(options.markdown
      ? {
          async sendDirectMarkdownMessage(input: QqDirectMarkdownMessageInput) {
            sentMarkdown.push(input);
            return { messageId: `markdown-reply-${sentMarkdown.length}` };
          }
        }
      : {})
  };
  const service = new QqAgentService({
    readConfig: () => options.config ?? config(),
    readBinding: () => options.currentBinding ?? binding(options.userOpenId),
    client,
    fetch: options.fetch,
    renderEmailCard: options.renderEmailCard ?? (async () => Buffer.from("test-png")),
    now: () => Date.parse("2026-08-31T12:00:00.000Z")
  });
  return { service, sent, sentMarkdown, sentImages };
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

test("QQ Agent sends the selected mail as one rich-media image without duplicate text", async () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userOpenId = `image-user-${suffix}`;
  const emailId = `agent-image-${suffix}`;
  addProcessedEmail(email({
    id: emailId,
    subject: `Adobe receipt ${suffix}`,
    receivedAt: "2026-08-31T10:00:00.000Z"
  }));

  const target = harness({ markdown: true, userOpenId });
  await target.service.handleDispatchEvent(event(`搜索 ${suffix}`, `image-search-${suffix}`, userOpenId));
  const textCountBeforeImage = target.sent.length + target.sentMarkdown.length;
  const result = await target.service.handleDispatchEvent(event("第一封邮件发给我", `image-send-${suffix}`, userOpenId));

  assert.deepEqual(result, { kind: "handled" });
  assert.equal(target.sentImages.length, 1);
  assert.equal(target.sentImages[0].userOpenId, userOpenId);
  assert.equal(target.sentImages[0].fileName, "mail-summary.png");
  assert.equal(target.sentImages[0].image.toString(), "test-png");
  assert.equal(target.sent.length + target.sentMarkdown.length, textCountBeforeImage);
  assert.equal(findQqNotificationReference({ userOpenId, messageId: "image-reply-1" })?.emailId, emailId);
});

test("QQ Agent blocks mail image sending when the media permission is disabled", async () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userOpenId = `image-denied-user-${suffix}`;
  addProcessedEmail(email({
    id: `agent-image-denied-${suffix}`,
    subject: `Denied image ${suffix}`,
    receivedAt: "2026-08-31T10:05:00.000Z"
  }));

  const target = harness({
    userOpenId,
    config: config({
      ...agentDefaults,
      permissions: { ...agentDefaults.permissions, sendMailImages: false }
    })
  });
  await target.service.handleDispatchEvent(event(`搜索 ${suffix}`, `image-denied-search-${suffix}`, userOpenId));
  await target.service.handleDispatchEvent(event("第 1 封邮件发给我", `image-denied-send-${suffix}`, userOpenId));

  assert.equal(target.sentImages.length, 0);
  assert.match(target.sent.at(-1)?.content ?? "", /没有开启权限.*mail\.sendImage/);
});

test("QQ Agent remembers school aliases and searches them instead of unrelated recent mail", async () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userOpenId = `school-user-${suffix}`;
  addProcessedEmail(email({
    id: `agent-school-${suffix}`,
    subject: `Wardlaw-Hartridge weekly update ${suffix}`,
    fromName: "Wardlaw-Hartridge School",
    fromAddress: "news@whschool.example",
    receivedAt: "2026-08-31T08:30:00.000Z",
    summaryZh: "学校发布了本周安排。"
  }));
  addProcessedEmail(email({
    id: `agent-ikea-${suffix}`,
    subject: `IKEA customer service chat ${suffix}`,
    fromName: "IKEA",
    fromAddress: "support@ikea.example",
    receivedAt: "2026-08-31T11:30:00.000Z",
    summaryZh: "客服聊天记录。"
  }));

  const target = harness({ markdown: true, userOpenId });
  await target.service.handleDispatchEvent(event("你能不能记住我的学校是wardlaw hartridge", `remember-${suffix}`, userOpenId));
  await target.service.handleDispatchEvent(event("搜索一下最近也没有什么来自学校的邮件", `school-search-${suffix}`, userOpenId));

  const reply = target.sentMarkdown.at(-1)?.markdown ?? target.sent.at(-1)?.content ?? "";
  assert.match(reply, /Wardlaw-Hartridge/i);
  assert.doesNotMatch(reply, /IKEA/);
});

test("QQ Agent asks for school memory before searching school mail", async () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userOpenId = `unknown-school-user-${suffix}`;
  addProcessedEmail(email({
    id: `agent-unknown-school-ikea-${suffix}`,
    subject: `IKEA customer service chat ${suffix}`,
    fromName: "IKEA",
    fromAddress: "support@ikea.example",
    receivedAt: "2026-08-31T11:30:00.000Z",
    summaryZh: "客服聊天记录。"
  }));

  const target = harness({ userOpenId });
  await target.service.handleDispatchEvent(event("搜索一下最近有没有来自学校的邮件", `unknown-school-${suffix}`, userOpenId));

  const reply = target.sent.at(-1)?.content ?? "";
  assert.match(reply, /还不知道.*学校/);
  assert.doesNotMatch(reply, /IKEA/);
});

test("QQ Agent loops through AI tool calls and sends Markdown replies", async () => {
  const suffix = `${process.pid}-${Date.now()}`;
  addProcessedEmail(email({
    id: `agent-ai-${suffix}`,
    subject: `Please finalize your lens preference ${suffix}`,
    receivedAt: "2026-08-31T17:12:00.000Z"
  }));
  updateAiSettings({
    apiKey: "agent-test-key",
    baseUrl: "https://api.example.test/v1/chat/completions",
    model: "agent-test-model",
    protocol: "openai-chat"
  });
  let callCount = 0;
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    callCount += 1;
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      messages?: Array<{ content?: string }>;
    };
    const prompt = body.messages?.at(-1)?.content ?? "";
    if (callCount === 1) {
      assert.match(prompt, new RegExp(suffix));
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              finish: false,
              toolCalls: [{ name: "mail.search", arguments: { query: suffix, period: "today" } }]
            })
          }
        }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    assert.match(prompt, /Please finalize your lens preference/);
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            finish: true,
            reply: "**今天有 1 封重要邮件**\n\n1. **Warby Parker** 需要你确认镜片方案。\n\n下一步：可以回复 `看第 1 封` 查看详情。"
          })
        }
      }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const target = harness({ fetch, markdown: true });
    const result = await target.service.handleDispatchEvent(event(`今天有没有 ${suffix} 相关的重要邮件`, `ai-${suffix}`));

    assert.deepEqual(result, { kind: "handled" });
    assert.equal(target.sent.length, 0);
    assert.equal(target.sentMarkdown.length, 1);
    assert.match(target.sentMarkdown[0].markdown, /\*\*今天有 1 封重要邮件\*\*/);
    assert.equal(target.sentMarkdown[0].msgId, `message-ai-${suffix}`);
    assert.equal(callCount, 2);
  } finally {
    updateAiSettings({ apiKey: " ", protocol: "auto" });
  }
});

test("QQ Agent can run multiple AI tool rounds before finishing", async () => {
  const suffix = `${process.pid}-${Date.now()}`;
  addProcessedEmail(email({
    id: `agent-multi-${suffix}`,
    subject: `Urgent account alert ${suffix}`,
    fromName: "Bank",
    fromAddress: "alerts@bank.example",
    receivedAt: "2026-08-31T09:45:00.000Z",
    summaryZh: "银行提醒账户需要确认。",
    originalText: "Please confirm the account activity before midnight."
  }));
  updateAiSettings({
    apiKey: "agent-test-key",
    baseUrl: "https://api.example.test/v1/chat/completions",
    model: "agent-test-model",
    protocol: "openai-chat"
  });
  let callCount = 0;
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    callCount += 1;
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      messages?: Array<{ content?: string }>;
    };
    const prompt = body.messages?.at(-1)?.content ?? "";
    if (callCount === 1) {
      assert.match(prompt, /toolTranscript/);
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              finish: false,
              toolCalls: [{ name: "mail.search", arguments: { query: suffix, limit: 1 } }]
            })
          }
        }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (callCount === 2) {
      assert.match(prompt, /Urgent account alert/);
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              finish: false,
              toolCalls: [{ name: "mail.getDetail", arguments: { index: 1 } }]
            })
          }
        }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    assert.match(prompt, /Please confirm the account activity/);
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            finish: true,
            reply: "**需要处理 1 封邮件**\n\n1. **Urgent account alert**：银行要求在午夜前确认账户活动。"
          })
        }
      }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const target = harness({ fetch, markdown: true });
    const result = await target.service.handleDispatchEvent(event(`帮我看看 ${suffix} 这封邮件具体要做什么`, `multi-${suffix}`));

    assert.deepEqual(result, { kind: "handled" });
    assert.equal(target.sentMarkdown.length, 1);
    assert.match(target.sentMarkdown[0].markdown, /需要处理 1 封邮件/);
    assert.equal(callCount, 3);
  } finally {
    updateAiSettings({ apiKey: " ", protocol: "auto" });
  }
});

test("QQ Agent can search and send a mail image across AI tool rounds", async () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userOpenId = `ai-image-user-${suffix}`;
  addProcessedEmail(email({
    id: `agent-ai-image-${suffix}`,
    subject: `Requested receipt ${suffix}`,
    receivedAt: "2026-08-31T09:50:00.000Z"
  }));
  updateAiSettings({
    apiKey: "agent-test-key",
    baseUrl: "https://api.example.test/v1/chat/completions",
    model: "agent-test-model",
    protocol: "openai-chat"
  });
  let callCount = 0;
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    callCount += 1;
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      messages?: Array<{ content?: string }>;
    };
    const prompt = body.messages?.at(-1)?.content ?? "";
    if (callCount === 1) {
      assert.match(body.messages?.[0]?.content ?? "", /mail\.sendImage/);
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              finish: false,
              toolCalls: [{ name: "mail.search", arguments: { query: suffix, limit: 1 } }]
            })
          }
        }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    assert.match(prompt, /Requested receipt/);
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            finish: false,
            toolCalls: [{ name: "mail.sendImage", arguments: { index: 1 } }]
          })
        }
      }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const target = harness({ fetch, markdown: true, userOpenId });
    const result = await target.service.handleDispatchEvent(event(
      `请找到 ${suffix} 对应的邮件，完成后使用原通知形式交给我`,
      `ai-image-${suffix}`,
      userOpenId
    ));

    assert.deepEqual(result, { kind: "handled" });
    assert.equal(callCount, 2);
    assert.equal(target.sentImages.length, 1);
    assert.equal(target.sent.length, 0);
    assert.equal(target.sentMarkdown.length, 0);
  } finally {
    updateAiSettings({ apiKey: " ", protocol: "auto" });
  }
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
