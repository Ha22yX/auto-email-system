import assert from "node:assert/strict";
import test from "node:test";
import { buildEmailClassificationPrompt, compactEmailForAnalysis } from "./ai";
import type { IncomingEmail } from "./types";

function email(overrides: Partial<IncomingEmail> = {}): IncomingEmail {
  return {
    mailboxId: "mailbox-1",
    externalUid: "42",
    subject: "School policy update",
    fromName: "School Office",
    fromAddress: "office@example.edu",
    toText: "student@example.com",
    receivedAt: "2026-09-01T12:00:00.000Z",
    originalText: "Please review the attached policy before September 3.",
    ...overrides
  };
}

test("classification prompt requires recipient-focused complete Markdown analysis", () => {
  const prompt = buildEmailClassificationPrompt(email());

  assert.match(prompt, /站在收件人的角度/);
  assert.match(prompt, /完整保留/);
  assert.match(prompt, /安全 Markdown/);
  assert.match(prompt, /日期时间与时区/);
  assert.match(prompt, /输出前做一次静默完整性检查/);
});

test("classification input preserves long-message tail and explicit attachment analysis", () => {
  const source = compactEmailForAnalysis(email({
    originalText: `${"开头信息。".repeat(7000)}正文末尾的最终截止时间是 9 月 3 日。`,
    attachments: [{
      id: "attachment-1",
      filename: "policy.pdf",
      contentType: "application/pdf",
      size: 2048,
      related: false,
      supportedForVision: true
    }],
    multimodalAnalysis: {
      model: "vision-model",
      summaryZh: "附件列出完整着装要求。",
      reasonZh: "正文没有列出具体限制。",
      categoryHint: "important",
      importantSignalsZh: ["9 月 3 日前确认。"],
      analyzedAt: "2026-09-01T12:01:00.000Z",
      attachmentCount: 1,
      analyzedAttachmentNames: ["policy.pdf"],
      skippedAttachmentNames: []
    }
  }));

  assert.match(source, /邮件中段因长度限制未完整传入/);
  assert.match(source, /正文末尾的最终截止时间是 9 月 3 日/);
  assert.match(source, /policy\.pdf/);
  assert.match(source, /9 月 3 日前确认/);
});
