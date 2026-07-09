import { ImapFlow } from "imapflow";
import { hasProcessed } from "../store";
import type { IncomingEmail, Mailbox } from "../types";
import { parseIncomingEmail } from "./parse";

export type FetchedEmail = {
  email: IncomingEmail;
  markRead: () => Promise<{ marked: boolean; note?: string }>;
};

export async function fetchUnreadImap(mailbox: Mailbox, limit: number): Promise<FetchedEmail[]> {
  const client = new ImapFlow({
    host: mailbox.host,
    port: mailbox.port,
    secure: mailbox.secure,
    auth: {
      user: mailbox.username,
      pass: mailbox.password
    },
    logger: false
  });

  const results: FetchedEmail[] = [];

  await client.connect();
  const lock = await client.getMailboxLock(mailbox.folder || "INBOX");
  try {
    const unseen = (await client.search({ seen: false }, { uid: true })) || [];
    const uids = unseen.slice(0, limit);

    for await (const message of client.fetch(
      uids,
      { uid: true, source: true, envelope: true, internalDate: true },
      { uid: true }
    )) {
      const uid = String(message.uid);
      if (hasProcessed(mailbox.id, uid) || !message.source) continue;

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
        markRead: async () => {
          const marker = new ImapFlow({
            host: mailbox.host,
            port: mailbox.port,
            secure: mailbox.secure,
            auth: {
              user: mailbox.username,
              pass: mailbox.password
            },
            logger: false
          });
          await marker.connect();
          const markerLock = await marker.getMailboxLock(mailbox.folder || "INBOX");
          try {
            await marker.messageFlagsAdd(message.uid, ["\\Seen"], { uid: true });
          } finally {
            markerLock.release();
            await marker.logout();
          }
          return { marked: true };
        }
      });
    }
  } finally {
    lock.release();
    await client.logout();
  }

  return results;
}
