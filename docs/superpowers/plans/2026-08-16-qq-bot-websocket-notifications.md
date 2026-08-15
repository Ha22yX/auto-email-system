# QQ Bot WebSocket Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add official QQ Bot direct-message notifications through WebSocket events and REST delivery, with secure credentials, verified single-user binding, independent per-channel retries, and a management-panel workflow.

**Architecture:** One in-process QQ manager owns access-token caching and the Gateway lifecycle. A channel-neutral notification dispatcher writes idempotent SQLite delivery rows after each email commit and sends WeChat and QQ independently. QQ binding is established only by a short-lived code received in a direct-chat Gateway event; active notifications then use the official REST API.

**Tech Stack:** Node.js 24, TypeScript 5.9, Express 5, `node:sqlite`, `node:crypto`, `ws`, React 19, SSE, Node test runner, Zod.

## Global Constraints

- Use only official `https://api.bot.qq.com` and `wss://api.bot.qq.com` endpoints in production.
- Run QQ support inside the existing Node server; do not start OpenClaw, browser automation, or another service.
- Support one bot and one bound direct-chat recipient in the first version.
- Do not respond to arbitrary QQ messages after binding.
- Never place the QQ AppSecret or access token in Git, logs, SSE events, browser responses, or command-line arguments.
- Keep access tokens memory-only and encrypt the AppSecret at rest with AES-256-GCM.
- Preserve the invariant that a provider email is marked read only after the processed email is committed to SQLite.
- Notification failure must never roll back email storage, block provider read marking, or duplicate a successful channel delivery.
- Target less than 25 MB steady-state incremental RSS.
- Regenerate the exposed QQ AppSecret before a future public/production handoff; for this requested deployment, inject the previously supplied secret only through the authenticated settings path or protected server environment.

---

## File Map

**Create**

- `server/src/credential-crypto.ts`: master-key loading plus AES-256-GCM credential encryption.
- `server/src/credential-crypto.test.ts`: encryption, restart, tamper, and redaction tests.
- `server/src/qq/types.ts`: Gateway, REST, binding, status, and error contracts.
- `server/src/qq/credentials.ts`: App access-token cache and refresh coordination.
- `server/src/qq/credentials.test.ts`: token lifetime and forced-refresh tests.
- `server/src/qq/client.ts`: QQ direct-message REST client and error classification.
- `server/src/qq/client.test.ts`: active/passive payload and error tests.
- `server/src/qq/gateway.ts`: WebSocket state machine, heartbeat, Resume, and event normalization.
- `server/src/qq/gateway.test.ts`: scripted mock-Gateway protocol tests.
- `server/src/qq/binding.ts`: binding code lifecycle and direct-chat event handling.
- `server/src/qq/binding.test.ts`: binding security and capability-event tests.
- `server/src/qq/manager.ts`: lifecycle facade used by routes and server startup.
- `server/src/notifications/format.ts`: channel-neutral email message model and renderers.
- `server/src/notifications/dispatcher.ts`: SQLite-backed multi-channel delivery worker.
- `server/src/notifications/dispatcher.test.ts`: independent send, retry, pause, and recovery tests.
- `src/components/QqNotificationPanel.tsx`: QQ configuration, connection, binding, and health UI.

**Modify**

- `package.json` and `package-lock.json`: add `ws` and `@types/ws`.
- `server/src/types.ts` and `src/types.ts`: channel settings, QQ public status, and delivery types.
- `server/src/store.ts` and `server/src/store.test.ts`: schema migration, encrypted QQ configuration, Gateway state, binding state, and delivery ledger.
- `server/src/notifications/clawbot.ts`: retain WeChat transport only and consume shared formatter output.
- `server/src/notifications/pending.ts`: delegate legacy retry entry points to the dispatcher.
- `server/src/email/processor.ts`: enqueue channel deliveries after insert and stop awaiting network sends.
- `server/src/routes.ts` and `server/src/routes.test.ts`: safe QQ settings, status, bind, rebind, start/stop, and test routes.
- `server/src/server.ts`: start/stop QQ manager and dispatcher with the application lifecycle.
- `src/api.ts`: typed QQ and notification-channel endpoints.
- `src/App.tsx`: channel selector and QQ panel integration.
- `src/styles.css`: compact channel workspace, binding code, health, and responsive styles.
- `README.md` and `README.zh-CN.md`: official QQ Bot setup and security notes.

---

### Task 1: Add Secure QQ Settings and Persistent State

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `server/src/credential-crypto.ts`
- Create: `server/src/credential-crypto.test.ts`
- Modify: `server/src/types.ts`
- Modify: `src/types.ts`
- Modify: `server/src/store.ts`
- Modify: `server/src/store.test.ts`

**Interfaces:**
- Produces: `encryptCredential(value: string): string`
- Produces: `decryptCredential(envelope: string): string`
- Produces: `readQqBotConfig(): QqBotConfig`
- Produces: `publicQqBotSettings(config: QqBotConfig): PublicQqBotSettings`
- Produces: `updateQqBotSettings(input: QqBotSettingsInput): PublicQqBotSettings`
- Produces: QQ Gateway, binding, event-deduplication, and `notification_deliveries` store operations used by later tasks.

- [ ] **Step 1: Install the WebSocket dependency**

Run:

```powershell
npm install ws
npm install --save-dev @types/ws
```

Expected: `package.json` and lockfile contain `ws` and `@types/ws` without unrelated upgrades.

- [ ] **Step 2: Write failing credential and store tests**

Add tests that assert the ciphertext never contains the secret, decrypts with the same key, rejects a modified authentication tag, returns only `hasAppSecret`/`maskedAppSecret` publicly, retains the saved secret on blank update, and creates the required tables and unique delivery key.

```ts
test("QQ AppSecret is encrypted and never returned by public settings", () => {
  updateQqBotSettings({ appId: "1900000000", appSecret: "test-secret", enabled: false });
  const publicSettings = publicQqBotSettings(readQqBotConfig());
  assert.equal(publicSettings.hasAppSecret, true);
  assert.equal(JSON.stringify(publicSettings).includes("test-secret"), false);
  assert.equal(readStoredCredentialEnvelope("qq-app-secret").includes("test-secret"), false);
});

test("delivery identity is unique per email and channel", () => {
  enqueueNotificationDelivery("email-1", "qq");
  enqueueNotificationDelivery("email-1", "qq");
  assert.equal(listNotificationDeliveries({ emailId: "email-1" }).length, 1);
});
```

- [ ] **Step 3: Run focused tests and confirm failure**

Run:

```powershell
node --import tsx --test server/src/credential-crypto.test.ts server/src/store.test.ts
```

Expected: FAIL because credential and delivery APIs do not exist.

- [ ] **Step 4: Implement credentials, types, and schema migration**

Use a versioned envelope and separate credential table:

```ts
export type EncryptedCredential = `v1:${string}:${string}:${string}`;

export type NotificationChannelSettings = {
  enabled: boolean;
  notifyCategories: Record<MailCategory, boolean>;
};

export type QqBotConfig = NotificationChannelSettings & {
  appId: string;
  encryptedAppSecret: string;
};

export type NotificationDeliveryStatus = "pending" | "sending" | "sent" | "retry" | "paused";
export type NotificationChannel = "wechat" | "qq";
```

Create `credentials`, `qq_state`, `qq_event_dedupe`, and `notification_deliveries` tables. Add `UNIQUE(emailId, channel)` and indexes for `(status, nextAttemptAt)` and event cleanup. Migrate legacy notification settings into `notification.wechat`; initialize QQ disabled; backfill legacy WeChat delivery state transactionally and idempotently.

- [ ] **Step 5: Run focused tests**

Run:

```powershell
node --import tsx --test server/src/credential-crypto.test.ts server/src/store.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the foundation**

```powershell
git add package.json package-lock.json server/src/credential-crypto.ts server/src/credential-crypto.test.ts server/src/types.ts src/types.ts server/src/store.ts server/src/store.test.ts
git commit -m "Add secure QQ notification state"
```

---

### Task 2: Implement Access Tokens and QQ REST Messaging

**Files:**
- Create: `server/src/qq/types.ts`
- Create: `server/src/qq/credentials.ts`
- Create: `server/src/qq/credentials.test.ts`
- Create: `server/src/qq/client.ts`
- Create: `server/src/qq/client.test.ts`

**Interfaces:**
- Consumes: `readQqBotConfig()` and decrypted credential access from Task 1.
- Produces: `QqTokenProvider.getToken(options?: { force?: boolean }): Promise<string>`
- Produces: `QqClient.sendDirectMessage(input: QqDirectMessageInput): Promise<QqSendResult>`
- Produces: `QqApiError` with `kind`, `status`, `code`, `retryAfterMs`, and sanitized `message`.

- [ ] **Step 1: Write token-provider tests**

```ts
test("concurrent token requests share one HTTP call", async () => {
  const provider = createTokenProvider({ fetch: fakeTokenFetch });
  const [first, second] = await Promise.all([provider.getToken(), provider.getToken()]);
  assert.equal(first, second);
  assert.equal(fakeTokenFetch.calls, 1);
});

test("401 invalidation forces one new token", async () => {
  await provider.getToken();
  provider.invalidate();
  await provider.getToken({ force: true });
  assert.equal(fakeTokenFetch.calls, 2);
});
```

- [ ] **Step 2: Run token tests and confirm failure**

Run:

```powershell
node --import tsx --test server/src/qq/credentials.test.ts
```

Expected: FAIL because the token provider is absent.

- [ ] **Step 3: Implement the token provider**

Request only the official endpoint, parse `access_token` and `expires_in`, cache until `expiresAt - 90 seconds`, share one in-flight promise, and redact all errors.

```ts
type TokenCache = { value: string; expiresAt: number };

export class QqTokenProvider {
  async getToken(options: { force?: boolean } = {}): Promise<string>;
  invalidate(): void;
  clear(): void;
}
```

- [ ] **Step 4: Write REST client tests**

Verify active messages omit `msg_id`, passive messages include it, payloads use `msg_type: 0`, 401 refreshes exactly once, 429 exposes delay, 5xx is transient, and relationship/permission errors are permanent.

```ts
await client.sendDirectMessage({ userOpenId: "user-openid", content: "hello" });
assert.deepEqual(lastJsonBody, { content: "hello", msg_type: 0 });
```

- [ ] **Step 5: Run REST tests and confirm failure**

Run:

```powershell
node --import tsx --test server/src/qq/client.test.ts
```

Expected: FAIL because the client is absent.

- [ ] **Step 6: Implement the REST client and rerun tests**

```powershell
node --import tsx --test server/src/qq/credentials.test.ts server/src/qq/client.test.ts
```

Expected: PASS with no network access from tests.

- [ ] **Step 7: Commit the QQ HTTP layer**

```powershell
git add server/src/qq
git commit -m "Add official QQ bot REST client"
```

---

### Task 3: Implement the QQ Gateway State Machine

**Files:**
- Create: `server/src/qq/gateway.ts`
- Create: `server/src/qq/gateway.test.ts`
- Modify: `server/src/qq/types.ts`

**Interfaces:**
- Consumes: `QqTokenProvider.getToken()` from Task 2 and QQ state store functions from Task 1.
- Produces: `QqGateway.start(): Promise<void>`
- Produces: `QqGateway.stop(): Promise<void>`
- Produces: `QqGateway.status(): QqGatewayStatus`
- Produces: `QqGateway.onDispatch(listener: (event: QqDispatchEvent) => void): () => void`

- [ ] **Step 1: Write scripted Gateway tests**

Cover Hello -> Identify, periodic heartbeat with latest sequence, ACK tracking, missing-ACK reconnect, Resume with persisted session/sequence, invalid session -> Identify, op 7 reconnect, one-socket ownership, and exponential backoff cancellation on stop.

```ts
server.send({ op: 10, d: { heartbeat_interval: 50 } });
assert.equal(clientMessages[0].op, 2);
assert.equal(clientMessages[0].d.intents, 1 << 25);
assert.deepEqual(clientMessages[0].d.shard, [0, 1]);
```

- [ ] **Step 2: Run Gateway tests and confirm failure**

Run:

```powershell
node --import tsx --test server/src/qq/gateway.test.ts
```

Expected: FAIL because `QqGateway` is absent.

- [ ] **Step 3: Implement protocol state and normalized events**

Use explicit opcodes and one timer owner:

```ts
const QQ_OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11
} as const;
```

Persist session and sequence only after valid dispatch frames. Publish sanitized status changes through a callback supplied by the manager.

- [ ] **Step 4: Run Gateway tests**

Run:

```powershell
node --import tsx --test server/src/qq/gateway.test.ts
```

Expected: PASS and all sockets/timers close at test completion.

- [ ] **Step 5: Commit the Gateway**

```powershell
git add server/src/qq/gateway.ts server/src/qq/gateway.test.ts server/src/qq/types.ts
git commit -m "Add resilient QQ bot Gateway"
```

---

### Task 4: Add Verified QQ Direct-Chat Binding

**Files:**
- Create: `server/src/qq/binding.ts`
- Create: `server/src/qq/binding.test.ts`
- Create: `server/src/qq/manager.ts`
- Modify: `server/src/store.ts`
- Modify: `server/src/store.test.ts`

**Interfaces:**
- Consumes: normalized Gateway dispatch events and `QqClient.sendDirectMessage()`.
- Produces: `createQqBindingCode(): { code: string; expiresAt: string }`
- Produces: `handleQqDispatchEvent(event: QqDispatchEvent): Promise<void>`
- Produces: `getQqStatus(): QqBotStatus`
- Produces: `startQqManager()`, `stopQqManager()`, `rebindQqRecipient()`, and `testQqNotification()`.

- [ ] **Step 1: Write binding tests**

Verify exact trimmed code matching, 10-minute expiry, hashed storage, single use, duplicate-event rejection, preserving the old binding until a new one succeeds, passive confirmation with the incoming `msg_id`, proactive test, and ignoring ordinary chat after binding.

```ts
const binding = createQqBindingCode();
await handleQqDispatchEvent(c2cMessage({ content: binding.code, userOpenId: "u-1", id: "m-1" }));
assert.equal(readQqRecipient().userOpenId, "u-1");
assert.equal(sentMessages[0].msgId, "m-1");
assert.equal(sentMessages[1].msgId, undefined);
```

- [ ] **Step 2: Run binding tests and confirm failure**

Run:

```powershell
node --import tsx --test server/src/qq/binding.test.ts
```

Expected: FAIL because binding and manager modules are absent.

- [ ] **Step 3: Implement binding and capability state**

Normalize recipient identity from documented event shapes, hash codes with SHA-256 plus random salt, consume in one transaction, mask `user_openid` in public status, and update proactive/friendship state from receive/reject/add/delete events.

- [ ] **Step 4: Run binding and store tests**

Run:

```powershell
node --import tsx --test server/src/qq/binding.test.ts server/src/store.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit binding**

```powershell
git add server/src/qq server/src/store.ts server/src/store.test.ts
git commit -m "Add secure QQ direct-chat binding"
```

---

### Task 5: Replace Email-Level Notification State with a Channel Dispatcher

**Files:**
- Create: `server/src/notifications/format.ts`
- Create: `server/src/notifications/dispatcher.ts`
- Create: `server/src/notifications/dispatcher.test.ts`
- Modify: `server/src/notifications/clawbot.ts`
- Modify: `server/src/notifications/pending.ts`
- Modify: `server/src/email/processor.ts`
- Modify: `server/src/store.ts`

**Interfaces:**
- Consumes: delivery store operations, existing WeChat sender, and QQ manager/client.
- Produces: `enqueueEmailNotifications(email: ProcessedEmail): void`
- Produces: `scheduleNotificationDispatch(delayMs?: number): void`
- Produces: `retryNotificationDeliveries(limit?: number): Promise<DeliveryBatchResult>`
- Produces: `buildEmailNotificationModel(email, mailbox)` and per-channel renderers.

- [ ] **Step 1: Write dispatcher tests**

Cover independent channel eligibility, unique enqueue, parallel channel results, retry timing, permanent pause, restart recovery from stale `sending`, category settings, and one channel succeeding while another fails.

```ts
enqueueEmailNotifications(email);
await retryNotificationDeliveries();
assert.equal(delivery(email.id, "wechat").status, "sent");
assert.equal(delivery(email.id, "qq").status, "retry");
```

- [ ] **Step 2: Run dispatcher tests and confirm failure**

Run:

```powershell
node --import tsx --test server/src/notifications/dispatcher.test.ts
```

Expected: FAIL because the dispatcher is absent.

- [ ] **Step 3: Implement transactional enqueue and claims**

Use `INSERT OR IGNORE`, claim only due rows, and recover stale sends older than five minutes. Retry transient failures with capped exponential backoff plus jitter. Pause permission, relationship, missing-binding, and invalid-credential errors.

- [ ] **Step 4: Move email processing to asynchronous notification enqueue**

Replace the awaited WeChat block after `addProcessedEmail` with:

```ts
if (insertedEmail) {
  enqueueEmailNotifications(insertedEmail);
  scheduleNotificationDispatch(0);
}
```

Keep `item.markRead()` after successful database insertion. Do not wait for any notification network call before provider read marking.

- [ ] **Step 5: Preserve legacy entry points and shared formatting**

Make `pending.ts` delegate to the new worker and let `clawbot.ts` remain a WeChat transport. Move common Chinese summary structure to `format.ts`; render clear category-specific headers for both platforms.

- [ ] **Step 6: Run notification and processor-related tests**

Run:

```powershell
node --import tsx --test server/src/notifications/dispatcher.test.ts server/src/store.test.ts
```

Expected: PASS with no external calls.

- [ ] **Step 7: Commit multi-channel delivery**

```powershell
git add server/src/notifications server/src/email/processor.ts server/src/store.ts
git commit -m "Add durable multi-channel notification delivery"
```

---

### Task 6: Add Authenticated QQ Routes, SSE, and Server Lifecycle

**Files:**
- Modify: `server/src/routes.ts`
- Modify: `server/src/routes.test.ts`
- Modify: `server/src/server.ts`
- Modify: `server/src/events.ts`
- Modify: `src/api.ts`

**Interfaces:**
- Consumes: Task 4 manager and Task 5 dispatcher.
- Produces: `GET/PUT /api/settings/notification`
- Produces: `GET /api/qq/status`
- Produces: `POST /api/qq/start`, `/stop`, `/bind`, `/rebind`, and `/test`
- Produces: SSE event types `qq-status`, `qq-binding`, and `notification-delivery`.

- [ ] **Step 1: Write route tests**

Verify authentication, schema validation, write-only secret behavior, blank-secret retention, status redaction, binding code response, rebind preservation, test-send errors, and no secret/token in serialized responses.

```ts
assert.equal(JSON.stringify(response.body).includes(submittedSecret), false);
assert.equal(response.body.qq.hasAppSecret, true);
assert.match(response.body.binding.code, /^[A-Z0-9]{6}$/);
```

- [ ] **Step 2: Run route tests and confirm failure**

Run:

```powershell
node --import tsx --test server/src/routes.test.ts
```

Expected: FAIL on missing QQ routes and schemas.

- [ ] **Step 3: Implement schemas and routes**

Use a discriminated channel settings schema. Return only public QQ settings and masked status. Start or restart the manager after credential changes; resume paused deliveries after successful binding or restored capability.

- [ ] **Step 4: Wire server startup and shutdown**

Start the dispatcher and QQ manager after SQLite recovery. Register `SIGTERM` and `SIGINT` handlers that stop Gateway timers/socket before closing the HTTP server. A QQ startup failure logs a sanitized warning and does not prevent the mail service from listening.

- [ ] **Step 5: Publish SSE changes**

```ts
publishAppEvent("qq-status", getPublicQqStatus());
publishAppEvent("notification-delivery", { channel, status, pendingCount });
```

Do not include open IDs, codes, tokens, secrets, or email bodies.

- [ ] **Step 6: Run route and lifecycle tests**

Run:

```powershell
node --import tsx --test server/src/routes.test.ts server/src/qq/*.test.ts server/src/notifications/dispatcher.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit API integration**

```powershell
git add server/src/routes.ts server/src/routes.test.ts server/src/server.ts server/src/events.ts src/api.ts
git commit -m "Expose QQ bot notification controls"
```

---

### Task 7: Build the QQ Notification Management UI

**Files:**
- Create: `src/components/QqNotificationPanel.tsx`
- Modify: `src/App.tsx`
- Modify: `src/styles.css`
- Modify: `src/types.ts`

**Interfaces:**
- Consumes: typed API methods and SSE hints from Task 6.
- Produces: a channel selector, QQ credentials, Gateway health, binding flow, category controls, and delivery status.

- [ ] **Step 1: Extract channel state normalization tests or pure helpers**

Add pure helper tests for channel category normalization, QQ status labels, binding-code countdown, and action availability.

```ts
assert.deepEqual(qqStatusPresentation({ gateway: "online", proactive: "enabled" }), {
  tone: "success",
  label: "QQ 通知可用"
});
```

- [ ] **Step 2: Run helper tests and confirm failure**

Run:

```powershell
node --import tsx --test src/qq-notification-state.test.ts
```

Expected: FAIL because helpers are absent.

- [ ] **Step 3: Implement the compact channel workspace**

Use two tabs or a segmented channel control, not nested cards. QQ includes AppID, write-only AppSecret, connection status, bind/rebind, copyable expiring code, bound-state summary, test action, and independent category toggles. Disable impossible actions and show actionable errors inline.

- [ ] **Step 4: Add stable motion and responsive layout**

Keep panel dimensions stable during status refreshes, animate channel content with opacity/translate only, reserve status/error space, and support the existing fixed viewport with panel-local scrolling. Respect `prefers-reduced-motion`.

- [ ] **Step 5: Build and inspect UI**

Run:

```powershell
npm run build
```

Expected: TypeScript and Vite build succeed.

Start locally:

```powershell
npm run dev
```

Inspect desktop and narrow layouts in the browser. Verify no overlap, clipped controls, whole-page vertical scrolling, secret value exposure, or layout shift during SSE updates.

- [ ] **Step 6: Commit the UI**

```powershell
git add src/components/QqNotificationPanel.tsx src/App.tsx src/styles.css src/types.ts src/qq-notification-state.ts src/qq-notification-state.test.ts
git commit -m "Add QQ notification management UI"
```

---

### Task 8: Complete Integration, Documentation, and Regression Verification

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: tests touched in Tasks 1-7 as needed for final integration corrections.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: a release-ready, documented QQ notification feature.

- [ ] **Step 1: Add the end-to-end mocked integration test**

Exercise token acquisition, Gateway Identify, direct-chat binding, passive confirmation, proactive test, email delivery, duplicate event, disconnect, Resume, and process-style manager restart against local mock servers.

```ts
assert.equal(mockQq.messages.filter((message) => message.content.includes(email.subject)).length, 1);
assert.equal(readDelivery(email.id, "qq").status, "sent");
```

- [ ] **Step 2: Run the entire server test suite**

Run:

```powershell
node --import tsx --test server/src/*.test.ts server/src/qq/*.test.ts server/src/notifications/*.test.ts
```

Expected: all tests pass and the process exits without open Gateway handles.

- [ ] **Step 3: Run the entire project verification**

Run:

```powershell
npm test --if-present
npm run build
git diff --check
```

Expected: all available tests pass, build succeeds, and `git diff --check` prints nothing.

- [ ] **Step 4: Document setup and security**

Document QQ platform C2C intent permission, AppID/AppSecret entry, start, bind code, proactive test, category switches, common permission/rate-limit errors, Baota `APP_CREDENTIAL_KEY`, and secret rotation. State clearly that the bot does not run an AI agent or reply to ordinary messages.

- [ ] **Step 5: Commit documentation and final integration fixes**

```powershell
git add README.md README.zh-CN.md server/src src package.json package-lock.json
git commit -m "Complete official QQ bot notifications"
```

---

### Task 9: Deploy Securely and Verify Production Recovery

**Files:**
- Modify only protected Baota environment/configuration and server data; do not add secrets to repository files.

**Interfaces:**
- Consumes: completed build and the previously supplied AppID/AppSecret.
- Produces: a Baota-managed production service with QQ connected and bound.

- [ ] **Step 1: Push the tested branch**

Run:

```powershell
git push origin main
```

Expected: GitHub contains the verified commits and no credential values.

- [ ] **Step 2: Create the production credential key**

Generate a 32-byte random key outside the command history, place it in Baota's protected project environment as `APP_CREDENTIAL_KEY`, and restart only after the environment is saved. Do not print the value.

- [ ] **Step 3: Deploy code and run database migration**

Pull the tested commit into the existing Baota Node project, install locked dependencies, build, and restart through the existing supervisor. Confirm `/api/health` returns 200 before saving QQ credentials.

- [ ] **Step 4: Save the QQ credentials through the authenticated API/UI**

Enter the configured AppID and the previously supplied AppSecret through the management panel's write-only field. Verify the stored SQLite credential is an encrypted envelope and that logs/browser responses do not contain the secret.

- [ ] **Step 5: Bind and test direct messages**

Create a binding code, send it in a direct chat with the bot, confirm passive binding and proactive test messages, then enable important and secondary categories as requested.

- [ ] **Step 6: Verify real email delivery and deduplication**

Process one important and one secondary email. Confirm one QQ message per enabled category, independent WeChat delivery, sent ledger rows, and no duplicate after manual retry or SSE refresh.

- [ ] **Step 7: Verify restart and memory behavior**

Restart the Baota project, confirm Gateway Resume or clean Identify, retained binding, no resent successful deliveries, and public health 200. Compare RSS before/after enabling QQ; incremental steady-state RSS must remain below 25 MB.

- [ ] **Step 8: Record final production evidence**

Record the deployed commit, health status, Gateway status, binding readiness, delivery test result, and RSS delta without recording credentials, tokens, full open IDs, or email bodies.
