import { simpleParser } from "mailparser";
import type { AddressObject } from "mailparser";
import type { EmailAttachment, IncomingEmail } from "../types";

const supportedVisionTypes = [/^image\//i, /^application\/pdf$/i];

function firstAddress(addresses?: AddressObject) {
  const first = addresses?.value?.[0];

  return {
    name: first?.name,
    address: first?.address
  };
}

function addressText(addresses?: AddressObject) {
  return addresses?.text;
}

function isSupportedForVision(contentType: string) {
  return supportedVisionTypes.some((pattern) => pattern.test(contentType));
}

function attachmentName(attachment: {
  filename?: string;
  contentType?: string;
  cid?: string;
  contentId?: string;
}) {
  return attachment.filename || attachment.cid || attachment.contentId || attachment.contentType || "unnamed";
}

function parseAttachments(
  attachments: Array<{
    filename?: string;
    contentType?: string;
    size?: number;
    cid?: string;
    contentId?: string;
    contentDisposition?: string;
    related?: boolean;
    content?: Buffer;
  }>
): EmailAttachment[] {
  return attachments.map((attachment, index) => {
    const contentType = attachment.contentType || "application/octet-stream";
    const content = Buffer.isBuffer(attachment.content) ? attachment.content : undefined;
    const size = attachment.size ?? content?.length ?? 0;
    const contentId = attachment.cid || attachment.contentId;
    const related = Boolean(attachment.related || attachment.contentDisposition === "inline" || contentId);
    const supportedForVision = isSupportedForVision(contentType);

    return {
      id: contentId || `attachment-${index + 1}`,
      filename: attachmentName(attachment),
      contentType,
      size,
      contentId,
      disposition: attachment.contentDisposition,
      related,
      supportedForVision,
      contentBase64: supportedForVision && content ? content.toString("base64") : undefined
    };
  });
}

export async function parseIncomingEmail(input: {
  mailboxId: string;
  externalUid: string;
  rawSource: Buffer | string;
  fallbackDate?: Date;
}): Promise<IncomingEmail> {
  const parsed = await simpleParser(input.rawSource);
  const from = firstAddress(parsed.from);
  const htmlText =
    typeof parsed.html === "string"
      ? parsed.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
      : "";

  return {
    mailboxId: input.mailboxId,
    externalUid: input.externalUid,
    messageId: parsed.messageId,
    subject: parsed.subject || "(无主题)",
    fromName: from.name,
    fromAddress: from.address,
    toText: addressText(parsed.to as AddressObject | undefined),
    receivedAt: (parsed.date || input.fallbackDate)?.toISOString(),
    originalText: parsed.text?.trim() || htmlText,
    originalHtml: typeof parsed.html === "string" ? parsed.html : undefined,
    rawSource: Buffer.isBuffer(input.rawSource) ? input.rawSource.toString("utf8") : input.rawSource,
    attachments: parseAttachments(parsed.attachments ?? [])
  };
}
