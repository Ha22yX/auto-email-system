import { ImapFlow } from "imapflow";
import type { IncomingEmail, Mailbox } from "../types";
import { parseIncomingEmail } from "./parse";

export type FetchedEmail = {
  email: IncomingEmail;
  markRead: () => Promise<{ marked: boolean; note?: string }>;
};

function createImapClient(mailbox: Mailbox) {
  return new ImapFlow({
    host: mailbox.host,
    port: mailbox.port,
    secure: mailbox.secure,
    auth: {
      user: mailbox.username,
      pass: mailbox.password
    },
    connectionTimeout: 20000,
    greetingTimeout: 15000,
    socketTimeout: 60000,
    logger: false
  });
}

function isSeen(flags: unknown) {
  if (!flags) return false;
  const values = Array.isArray(flags) ? flags : flags instanceof Set ? Array.from(flags) : [];
  return values.some((flag) => String(flag).toLowerCase() === "\\seen");
}

function readMarker(mailbox: Mailbox, uid: number, note?: string) {
  return async () => {
    const marker = createImapClient(mailbox);
    await marker.connect();
    const markerLock = await marker.getMailboxLock(mailbox.folder || "INBOX", { acquireTimeout: 15000 });
    try {
      await marker.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
    } finally {
      markerLock.release();
      await marker.logout();
    }
    return { marked: true, note };
  };
}

export async function fetchUnreadImap(mailbox: Mailbox, limit: number): Promise<FetchedEmail[]> {
  const client = createImapClient(mailbox);

  const results: FetchedEmail[] = [];

  await client.connect();
  const lock = await client.getMailboxLock(mailbox.folder || "INBOX", { acquireTimeout: 15000 });
  try {
    const unseen = (await client.search({ seen: false }, { uid: true })) || [];
    const uids = unseen.slice(0, limit);

    for await (const message of client.fetch(
      uids,
      { uid: true, source: true, envelope: true, internalDate: true },
      { uid: true }
    )) {
      const uid = String(message.uid);
      if (!message.source) continue;

      const fallbackDate =
        message.internalDate instanceof Date
          ? message.internalDate
          : message.internalDate
            ? new Date(message.internalDate)
            : undefined;

      const email = await parseIncomingEmail({
        mailboxId: mailbox.id,
        externalUid: uid,
        rawSource: message.source,
        fallbackDate
      });

      results.push({
        email,
        markRead: readMarker(mailbox, message.uid)
      });
    }
  } finally {
    lock.release();
    await client.logout();
  }

  return results;
}

export async function fetchInterruptedImapRecovery(mailbox: Mailbox, options: {
  afterUid: number;
  uidWindow?: number;
  limit?: number;
}): Promise<FetchedEmail[]> {
  const client = createImapClient(mailbox);
  const results: FetchedEmail[] = [];
  const uidWindow = options.uidWindow ?? 5000;
  const limit = options.limit ?? 5;
  const startUid = options.afterUid + 1;
  const endUid = options.afterUid + uidWindow;

  if (!Number.isFinite(startUid) || startUid <= 0) return results;

  await client.connect();
  const lock = await client.getMailboxLock(mailbox.folder || "INBOX", { acquireTimeout: 15000 });
  try {
    for await (const message of client.fetch(
      `${startUid}:${endUid}`,
      { uid: true, source: true, flags: true, internalDate: true },
      { uid: true }
    )) {
      if (results.length >= limit) break;
      if (!message.source || !isSeen(message.flags)) continue;

      const fallbackDate =
        message.internalDate instanceof Date
          ? message.internalDate
          : message.internalDate
            ? new Date(message.internalDate)
            : undefined;

      const email = await parseIncomingEmail({
        mailboxId: mailbox.id,
        externalUid: String(message.uid),
        rawSource: message.source,
        fallbackDate
      });

      results.push({
        email,
        markRead: readMarker(mailbox, message.uid, "从中断任务恢复，邮件已确认已读。")
      });
    }
  } finally {
    lock.release();
    await client.logout();
  }

  return results;
}
