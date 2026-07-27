import { getPendingNotificationEmails, getProcessedEmailById, readState, updateProcessedEmailNotification } from "../store";
import { sendEmailNotification, shouldNotifyEmail } from "./clawbot";
import { runAsUser } from "../user-context";
import { currentUserId } from "../user-context";
import { registeredUserIds } from "../user-registry";

let retryTimer: ReturnType<typeof setTimeout> | undefined;
const retryingUsers = new Set<string>();
let workerTimer: ReturnType<typeof setInterval> | undefined;

export function schedulePendingEmailNotificationRetry(delayMs = 1000) {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    void retryPendingEmailNotifications();
  }, delayMs);
}

export async function retryPendingEmailNotifications(limit = 20) {
  const userId = currentUserId();
  if (retryingUsers.has(userId)) {
    return { attempted: 0, sent: 0, failed: 0, skipped: true };
  }

  retryingUsers.add(userId);
  let attempted = 0;
  let sent = 0;
  let failed = 0;

  try {
    const state = readState();
    const mailboxById = new Map(state.mailboxes.map((mailbox) => [mailbox.id, mailbox]));
    const pending = getPendingNotificationEmails(limit).filter((email) =>
      shouldNotifyEmail(state.settings.notification, email)
    );

    for (const email of pending) {
      const current = readState();
      const latest = getProcessedEmailById(email.id);
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
    retryingUsers.delete(userId);
  }
}

export function startPendingNotificationRetryWorker() {
  if (workerTimer) return workerTimer;
  const tick = () => {
    for (const userId of registeredUserIds()) {
      void runAsUser(userId, () => retryPendingEmailNotifications());
    }
  };
  tick();
  workerTimer = setInterval(tick, 60_000);
  return workerTimer;
}
