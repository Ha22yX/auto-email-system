import { readState, updateProcessedEmailNotification } from "../store";
import { sendEmailNotification, shouldNotifyEmail } from "./clawbot";

let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retrying = false;

export function schedulePendingEmailNotificationRetry(delayMs = 1000) {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    void retryPendingEmailNotifications();
  }, delayMs);
}

export async function retryPendingEmailNotifications(limit = 20) {
  if (retrying) {
    return { attempted: 0, sent: 0, failed: 0, skipped: true };
  }

  retrying = true;
  let attempted = 0;
  let sent = 0;
  let failed = 0;

  try {
    const state = readState();
    const mailboxById = new Map(state.mailboxes.map((mailbox) => [mailbox.id, mailbox]));
    const pending = state.emails
      .filter((email) => Boolean(email.notificationError) && shouldNotifyEmail(state.settings.notification, email))
      .slice(0, limit);

    for (const email of pending) {
      const current = readState();
      const latest = current.emails.find((item) => item.id === email.id);
      if (!latest?.notificationError || !shouldNotifyEmail(current.settings.notification, latest)) continue;

      attempted += 1;
      try {
        await sendEmailNotification(current.settings.notification, latest, mailboxById.get(latest.mailboxId));
        updateProcessedEmailNotification(latest.id, {
          notifiedAt: new Date().toISOString(),
          notificationError: ""
        });
        sent += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        updateProcessedEmailNotification(latest.id, {
          notifiedAt: undefined,
          notificationError: message
        });
        failed += 1;
      }
    }

    if (pending.length === limit) {
      schedulePendingEmailNotificationRetry(5000);
    }

    return { attempted, sent, failed, skipped: false };
  } finally {
    retrying = false;
  }
}
