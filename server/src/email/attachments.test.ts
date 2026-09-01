import assert from "node:assert/strict";
import test from "node:test";
import { extractAttachmentText, listAgentAttachments, resolveAgentAttachment, safeAttachmentFilename } from "./attachments";
import { parseIncomingEmail } from "./parse";
import type { ProcessedEmail } from "../types";

function rawMail(filename = "school-plan.txt", contentType = "text/plain", body = "Deadline: Friday at 3 PM") {
  return [
    "From: School <office@school.example>",
    "To: student@example.com",
    "Subject: Weekly plan",
    "Date: Mon, 1 Sep 2026 12:00:00 +0000",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="test-boundary"',
    "",
    "--test-boundary",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Please read the attachment.",
    "--test-boundary",
    `Content-Type: ${contentType}; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(body).toString("base64"),
    "--test-boundary--",
    ""
  ].join("\r\n");
}

async function processedEmail(filename?: string, contentType?: string): Promise<ProcessedEmail> {
  const incoming = await parseIncomingEmail({
    mailboxId: "attachment-mailbox",
    externalUid: "attachment-uid",
    rawSource: rawMail(filename, contentType)
  });
  return {
    id: "attachment-email",
    ...incoming,
    processedAt: "2026-09-01T12:01:00.000Z",
    category: "important",
    summaryZh: "学校计划",
    reasonZh: "包含截止时间",
    actionItemsZh: ["查看附件"],
    readMarked: true
  };
}

test("attachment tools list, resolve, and safely extract stored MIME attachments", async () => {
  const email = await processedEmail();
  const listed = listAgentAttachments(email);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.safeFilename, "school-plan.txt");
  assert.equal(listed[0]?.canRead, true);
  assert.equal(listed[0]?.canSend, true);

  const resolved = await resolveAgentAttachment(email, { attachmentIndex: 1 });
  assert.match(extractAttachmentText(resolved), /Deadline: Friday at 3 PM/);
});

test("attachment tools sanitize filenames and block executable exports", async () => {
  const email = await processedEmail("payload.exe", "application/x-msdownload");
  const listed = listAgentAttachments(email);
  assert.equal(listed[0]?.canSend, false);
  assert.match(listed[0]?.blockedReason ?? "", /禁止导出/);
  assert.equal(safeAttachmentFilename("../../report.pdf"), "_.._report.pdf");
});
