# QQ Bot WebSocket Notification Design

## Problem

The mail system currently sends category-based notifications only through the in-process WeChat bridge. The user also wants official QQ bot direct-message notifications without OpenClaw, a separate agent process, or a public webhook. The QQ integration must bind the intended QQ user safely, survive process and network restarts, avoid duplicate notifications, and remain lightweight enough for the existing 2 GB server.

The current email-level `notifiedAt` and `notificationError` fields are not sufficient for multiple channels. A successful WeChat send can hide a failed QQ send, while retrying the whole email can duplicate a channel that already succeeded.

## Goals

- Connect directly to the official QQ Bot Gateway over WebSocket and use the official REST API for direct messages.
- Bind a QQ user through a short-lived verification code sent in a bot direct chat.
- Let WeChat and QQ independently enable notification categories.
- Deliver each email at most once per enabled channel while retaining recoverable failures for retry.
- Resume Gateway sessions when possible and reconnect automatically after token, network, or server interruptions.
- Expose useful connection, binding, permission, and delivery health in the management panel.
- Keep credentials out of logs, API responses, Git, and plaintext application settings.
- Add no OpenClaw runtime and no separate QQ worker process.

## Non-Goals

- The QQ bot will not act as a general AI assistant or reply to arbitrary conversation.
- The first version will not support QQ groups, channels, guilds, or multiple bound recipients.
- The integration will not use webhook callbacks or require a public QQ callback endpoint.
- It will not replace the existing WeChat notification channel.

## Official Protocol Constraints

The implementation follows the official QQ Bot API v2 documentation:

- Access tokens are obtained from `POST https://api.bot.qq.com/app/getAppAccessToken` with an AppID and AppSecret. Tokens are cached by their returned lifetime and refreshed before expiry.
- The Gateway is reached through `wss://api.bot.qq.com/websocket/`. The client handles Hello, Identify, Heartbeat, Heartbeat ACK, Resume, Reconnect, and invalid-session close paths.
- The Gateway subscribes only to `GROUP_AND_C2C_EVENT` (`1 << 25`) because the feature needs direct-chat and friendship events only.
- Direct messages are sent with `POST /v2/users/{user_openid}/messages` and `Authorization: QQBot ACCESS_TOKEN`.
- A passive reply includes the incoming `msg_id`. A later proactive email notification omits `msg_id` and is subject to QQ active-message permissions and rate limits.
- `user_openid` is bot-specific and must never be inferred from a QQ number.

Reference documentation:

- [Access token](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html)
- [WebSocket event subscription](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html)
- [Send a direct message](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html)

## Architecture

The integration runs inside the existing Node server and follows the current background-manager lifecycle.

### `qq/credentials.ts`

- Reads the configured AppID and decrypts the AppSecret only when requesting a token.
- Caches the access token in memory with its server-provided expiry.
- Refreshes early with a small safety window and deduplicates concurrent refresh requests.
- On an authenticated REST failure, invalidates the cache and permits one forced refresh and retry.
- Never publishes or logs token or secret values.

### `qq/gateway.ts`

- Owns one WebSocket connection for the configured bot.
- Implements the protocol state machine: connecting, identifying, online, resuming, reconnecting, stopped, and blocked.
- Starts heartbeats at the interval from Hello and treats a missing ACK as a dead connection.
- Persists `session_id` and the latest sequence number so a process restart can attempt Resume.
- Uses bounded exponential backoff with jitter, resets the delay after a stable connection, and prevents parallel sockets.
- Re-identifies when the session is invalid or cannot be resumed.
- Emits normalized application events without exposing raw credentials or retaining full message bodies.

### `qq/binding.ts`

- Creates a cryptographically random, single-use binding code with a 10-minute expiry.
- Stores only a hash of the code in SQLite.
- Accepts a binding only when a `C2C_MESSAGE_CREATE` event contains the exact active code.
- Stores the event author's bot-specific `user_openid` and the binding timestamp.
- Replies passively to the binding message with a confirmation, then performs a proactive test send.
- Records `C2C_MSG_RECEIVE`, `C2C_MSG_REJECT`, `FRIEND_ADD`, and `FRIEND_DEL` events as recipient capability state.
- Ignores ordinary direct-chat messages after binding, so the bot never behaves like Claude Code or another assistant.

### `qq/client.ts`

- Sends passive binding replies and proactive direct messages through the official REST API.
- Applies a request timeout and returns normalized result categories: success, authentication, rate-limited, transient, permission, relationship, and invalid-request.
- Retries an authentication failure once after forced token refresh.
- Honors rate-limit response timing rather than immediately repeating requests.

### `notifications/dispatcher.ts`

- Fans one processed email out to every enabled channel whose category switch is on.
- Builds the common structured email summary once, then renders channel-specific text within platform limits.
- Creates one delivery record per `(emailId, channel)` before any external send.
- Sends WeChat and QQ independently; one channel's result cannot overwrite the other.
- Schedules retryable failures with bounded exponential backoff.
- Keeps permanent failures visible but paused until settings, binding, or permission state changes.

The QQ Gateway is required for initial binding and live recipient-state events. It is not required for every proactive REST send. If valid credentials, a bound `user_openid`, and active-message permission remain available, the dispatcher may continue sending while the Gateway reconnects.

## Data Model

### Notification Settings

Notification settings become channel-oriented while preserving the current WeChat configuration during migration:

```ts
type NotificationChannelSettings = {
  enabled: boolean;
  notifyCategories: Record<MailCategory, boolean>;
};

type QqBotSettings = NotificationChannelSettings & {
  appId: string;
  hasAppSecret: boolean;
};

type NotificationSettings = {
  wechat: WeChatNotificationSettings;
  qq: QqBotSettings;
};
```

Public API responses expose `hasAppSecret` and a masked hint, never the encrypted value. An empty AppSecret submitted during an update means keep the existing secret. A separate explicit action removes it.

### Secret Storage

The AppSecret is encrypted with AES-256-GCM before it is written to SQLite. The master key comes from `APP_CREDENTIAL_KEY`; when absent in a local installation, the server generates `data/credential.key`, restricts file permissions where supported, and reuses it across restarts. Production deployment sets the environment variable through Baota and backs it up separately from Git. Changing the admin login password does not rotate or invalidate this key.

### QQ State

SQLite stores:

- Gateway session ID, sequence number, last connected time, last heartbeat ACK, and sanitized last error.
- Bound `user_openid`, binding time, relationship state, proactive-message state, and latest state-event time.
- Hashed binding code, expiry, and consumed time.
- A small event-deduplication ledger keyed by QQ event ID with automatic age-based cleanup.

Access tokens remain memory-only and are reacquired after restart.

### Delivery Ledger

A new `notification_deliveries` table contains:

- `emailId`
- `channel` (`wechat` or `qq`)
- `status` (`pending`, `sending`, `sent`, `retry`, `paused`)
- `attempts`
- `nextAttemptAt`
- `lastAttemptAt`
- `sentAt`
- `lastErrorCode` and sanitized `lastError`
- remote message ID when returned

The unique key is `(emailId, channel)`. Claiming a delivery and changing its state happen in SQLite transactions. A stale `sending` row is returned to `retry` on startup. Existing `notifiedAt` and `notificationError` remain readable as legacy aggregate fields during migration but are no longer the source of truth.

## Binding Flow

1. The administrator saves AppID and AppSecret and enables the QQ connection.
2. The server verifies credentials, starts the Gateway, and reports whether the required C2C intent is accepted.
3. The administrator clicks **Bind QQ**. The panel displays a short-lived code and concise instructions to add/open the bot and send that code in a direct chat.
4. The Gateway receives `C2C_MESSAGE_CREATE`. Duplicate event IDs are ignored.
5. Only an exact, unexpired, unused code binds the event author's `user_openid`.
6. The bot sends a passive confirmation using the incoming `msg_id`.
7. The server sends one proactive test notification. Its result determines whether proactive notifications are ready, rejected, or need further platform permission.
8. Rebinding invalidates the old recipient only after a new code succeeds. The existing binding remains usable while a new code is pending.

This explicit code prevents an unrelated user who happens to message the bot first from taking over the notification destination.

## Email Delivery Flow

1. Email scanning, AI classification, attachment analysis, and database insertion complete as they do today.
2. After the processed email is committed, the dispatcher evaluates each channel's enabled categories.
3. It inserts missing delivery rows with `INSERT OR IGNORE`; this is the idempotency boundary.
4. Ready deliveries are claimed transactionally and sent with a per-channel formatter.
5. Success records `sentAt` and the remote message ID.
6. Retryable failures record the next attempt without changing the email's processed state.
7. Permanent permission or binding failures become `paused`. Saving valid settings, completing a binding, or receiving a capability-restored event requeues affected rows.
8. SSE publishes delivery and QQ connection changes to the panel without introducing another polling loop.

Email processing never waits for QQ delivery to succeed. A notification outage therefore cannot cause an email to be skipped, reprocessed, or incorrectly left uncommitted.

## Error Handling

- **401 or invalid token:** invalidate the cached token, refresh once, and retry once.
- **429 rate limit:** honor server timing when available and add jitter before retry.
- **5xx, timeout, DNS, or connection reset:** retry with bounded exponential backoff.
- **Active messages disabled or friendship missing:** pause QQ deliveries and show the required user action.
- **Invalid AppID/AppSecret or missing C2C intent:** stop reconnect churn and show a blocked state until settings change.
- **Heartbeat ACK missing:** close the socket and Resume when possible.
- **Resume rejected or session invalid:** clear persisted session state and Identify again.
- **Duplicate Gateway event:** acknowledge normal protocol flow but do not repeat binding or state changes.
- **Process restart:** recover stale deliveries, reacquire an access token, and Resume or re-identify the Gateway.

Logs include state transitions, sanitized QQ error codes, delivery IDs, and retry timing. They exclude AppSecret, access tokens, full `user_openid`, binding codes, and complete email content.

## Management UI

The existing notification area becomes a compact channel workspace rather than another nested settings card.

- A channel selector shows **WeChat** and **QQ Bot** with online, action-needed, or disabled status.
- QQ credentials include AppID, masked AppSecret, save/test actions, and clear validation messages.
- A connection row shows Gateway state, heartbeat freshness, last successful connection, and the latest sanitized error.
- A binding row shows masked recipient identity, friendship/proactive-message state, bind or rebind action, code expiry, and test notification.
- Important, secondary, and ignore category controls are independent for QQ and WeChat.
- Delivery health shows pending, retrying, paused, and recent-failure counts by channel.
- State changes arrive through the existing SSE path and animate without resizing the surrounding layout.

The QQ AppSecret field is write-only. The UI never receives its stored value.

## Migration

On first startup after the upgrade:

1. Existing notification settings are moved into the `wechat` channel structure without changing behavior.
2. QQ is created disabled with no credentials or binding.
3. Existing successful legacy notifications create a sent WeChat delivery record when needed.
4. Existing failed legacy notifications create a retrying WeChat delivery record.
5. New email processing uses the delivery ledger exclusively.

The migration is idempotent and runs inside a transaction. It does not resend legacy successful notifications.

## Security

- The already shared QQ AppSecret must be regenerated in the QQ platform before production use.
- AppSecret and tokens are redacted from logs, errors, SSE events, database exports intended for diagnostics, and API responses.
- Secret decryption is limited to the credential module.
- Binding codes are random, hashed at rest, single-use, and expire after 10 minutes.
- Settings and bind/rebind endpoints remain behind the existing authenticated session and CSRF/origin protections.
- Inputs are schema-validated; message text is length-limited and contains no HTML.
- Only official `https://api.bot.qq.com` and `wss://api.bot.qq.com` endpoints are accepted in production; there is no user-editable QQ API URL.
- Full QQ event payloads are not persisted.

## Resource Budget

The feature adds one WebSocket, small timers, and bounded in-memory caches inside the existing Node process. Event deduplication and delivery queues are SQLite-backed. No OpenClaw, browser automation, child process, or second Node service is started. The target steady-state incremental RSS is below 25 MB.

## Testing

### Unit Tests

- Token caching, early refresh, concurrent refresh deduplication, and one forced refresh after 401.
- Gateway Hello/Identify, heartbeat/ACK, Resume, re-identify, reconnect backoff, and parallel-socket prevention.
- Exact-code binding, expiry, single use, wrong-code rejection, and duplicate-event deduplication.
- QQ REST error classification and active/passive message payloads.
- Message formatting and length limits for each category.
- AppSecret encryption, redaction, masked settings responses, and keep-existing-secret updates.

### Store and Dispatcher Tests

- Idempotent `(emailId, channel)` insertion.
- Independent WeChat and QQ success/failure results.
- Transactional claims, stale-send recovery, retry scheduling, and paused-delivery reactivation.
- Legacy notification migration without duplicate sends.
- Email commit remains successful when every notification channel is unavailable.

### Route and Integration Tests

- Authenticated settings, bind, rebind, status, and test-notification routes.
- SSE events for Gateway, binding, and delivery transitions.
- A scripted mock Gateway and REST server exercise bind, proactive test, notification delivery, disconnect, Resume, token refresh, and restart recovery without contacting QQ in the normal test suite.

### Production Verification

- Regenerate and save the AppSecret on the server.
- Confirm Gateway online and heartbeat freshness.
- Bind through a QQ direct chat and verify passive confirmation plus proactive test.
- Process one important and one secondary test email and confirm exactly one QQ notification for each enabled category.
- Restart the Baota-managed service and verify automatic reconnect, retained binding, and no duplicate notification.
- Observe process memory before and after enabling QQ to confirm the resource budget.

## Acceptance Criteria

- The management panel can configure, connect, bind, test, disable, and rebind the official QQ bot without OpenClaw.
- A newly processed email creates independent channel deliveries and sends QQ direct messages according to QQ-specific category switches.
- A restart or temporary Gateway outage does not lose binding, lose queued notifications, block email processing, or duplicate a successful delivery.
- Authentication, rate-limit, permission, and relationship failures produce distinct actionable states.
- No QQ secret or token appears in Git, logs, browser responses, or panel source.
- Existing WeChat behavior remains functional after migration.
