import { retryNotificationDeliveries, scheduleNotificationDispatch } from "./dispatcher";

export function schedulePendingEmailNotificationRetry(delayMs = 1000) {
  scheduleNotificationDispatch(delayMs);
}

export async function retryPendingEmailNotifications(limit = 20) {
  const result = await retryNotificationDeliveries(limit);
  return {
    attempted: result.attempted,
    sent: result.sent,
    failed: result.retried + result.paused,
    skipped: result.skipped
  };
}