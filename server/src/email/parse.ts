import { simpleParser } from "mailparser";
import type { AddressObject } from "mailparser";
import type { IncomingEmail } from "../types";

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
    rawSource: Buffer.isBuffer(input.rawSource) ? input.rawSource.toString("utf8") : input.rawSource
  };
}
