import assert from "node:assert/strict";
import test from "node:test";
import {
  buildContextTokenUpdatedMessage,
  captureWeclawTokenState,
  captureWeclawTokenMetadata,
  deriveWeclawTokenHealth,
  isWeclawTokenReminderDue,
  recordWeclawTokenSendResult
} from "./manager";

const capturedAt = "2026-08-04T00:00:00.000Z";

test("token health distinguishes verified, refresh-soon, expired, invalid, and unverified contexts", () => {
  const healthy = deriveWeclawTokenHealth(
    { hasToken: true, capturedAt, verifiedAt: "2026-08-04T00:01:00.000Z" },
    new Date("2026-08-04T12:00:00.000Z").getTime()
  );
  const refreshSoon = deriveWeclawTokenHealth(
    { hasToken: true, capturedAt, verifiedAt: "2026-08-04T00:01:00.000Z" },
    new Date("2026-08-04T20:00:00.000Z").getTime()
  );
  const expired = deriveWeclawTokenHealth(
    { hasToken: true, capturedAt, verifiedAt: "2026-08-04T00:01:00.000Z" },
    new Date("2026-08-05T00:00:00.000Z").getTime()
  );
  const invalid = deriveWeclawTokenHealth(
    {
      hasToken: true,
      capturedAt,
      verifiedAt: "2026-08-04T00:01:00.000Z",
      failedAt: "2026-08-04T01:00:00.000Z",
      lastError: "ret=-2"
    },
    new Date("2026-08-04T02:00:00.000Z").getTime()
  );
  const unverified = deriveWeclawTokenHealth(
    { hasToken: true, capturedAt },
    new Date("2026-08-04T02:00:00.000Z").getTime()
  );

  assert.equal(healthy.status, "healthy");
  assert.equal(healthy.contextReady, true);
  assert.equal(refreshSoon.status, "refresh-soon");
  assert.equal(refreshSoon.contextReady, true);
  assert.equal(expired.status, "expired");
  assert.equal(expired.contextReady, false);
  assert.equal(invalid.status, "invalid");
  assert.equal(invalid.contextReady, false);
  assert.equal(invalid.lastError, "ret=-2");
  assert.equal(unverified.status, "unverified");
  assert.equal(unverified.contextReady, false);
  assert.equal(healthy.estimatedExpiresAt, "2026-08-05T00:00:00.000Z");
});

test("capturing the same token preserves its original lifetime and failure until a send verifies it", () => {
  const failed = {
    token_hash: "same-token-hash",
    captured_at: capturedAt,
    observed_at: capturedAt,
    verified_at: "2026-08-04T00:01:00.000Z",
    failed_at: "2026-08-04T01:00:00.000Z",
    last_error: "ret=-2"
  };
  const captured = captureWeclawTokenMetadata(failed, "same-token-hash", "2026-08-04T02:00:00.000Z");

  assert.equal(captured.captured_at, capturedAt);
  assert.equal(captured.observed_at, "2026-08-04T02:00:00.000Z");
  assert.equal(captured.failed_at, "2026-08-04T01:00:00.000Z");
  assert.equal(captured.last_error, "ret=-2");

  const verified = recordWeclawTokenSendResult(captured, {
    at: "2026-08-04T02:01:00.000Z",
    success: true
  });
  assert.equal(verified.verified_at, "2026-08-04T02:01:00.000Z");
  assert.equal(verified.failed_at, undefined);
  assert.equal(verified.last_error, undefined);
});

test("capturing a new token clears stale verification and failure state", () => {
  const metadata = captureWeclawTokenMetadata(
    {
      token_hash: "old-token-hash",
      captured_at: capturedAt,
      verified_at: "2026-08-04T00:01:00.000Z",
      failed_at: "2026-08-04T01:00:00.000Z",
      last_error: "ret=-2"
    },
    "new-token-hash",
    "2026-08-04T02:00:00.000Z"
  );

  assert.deepEqual(metadata, {
    token_hash: "new-token-hash",
    captured_at: "2026-08-04T02:00:00.000Z",
    observed_at: "2026-08-04T02:00:00.000Z"
  });
});

test("same-token inbound activity does not reset the expiry reminder", () => {
  const captured = captureWeclawTokenState(
    {
      metadata: {
        token_hash: "same-token-hash",
        captured_at: capturedAt,
        verified_at: "2026-08-04T00:01:00.000Z"
      },
      reminder: {
        token_hash: "same-token-hash",
        attempted_at: "2026-08-04T20:00:00.000Z",
        reminded_at: "2026-08-04T20:00:01.000Z"
      }
    },
    "same-token-hash",
    "2026-08-04T21:00:00.000Z"
  );

  assert.equal(captured.metadata.captured_at, capturedAt);
  assert.equal(captured.metadata.observed_at, "2026-08-04T21:00:00.000Z");
  assert.equal(captured.reminder?.reminded_at, "2026-08-04T20:00:01.000Z");
});

test("token refresh reminder is due four hours before nominal expiry", () => {
  assert.equal(
    isWeclawTokenReminderDue(capturedAt, new Date("2026-08-04T19:59:59.999Z").getTime()),
    false
  );
  assert.equal(
    isWeclawTokenReminderDue(capturedAt, new Date("2026-08-04T20:00:00.000Z").getTime()),
    true
  );
});

test("token confirmation distinguishes a real refresh from a same-token verification", () => {
  const refreshed = buildContextTokenUpdatedMessage("2026-07-29T08:30:00.000Z", true);
  const verifiedOnly = buildContextTokenUpdatedMessage("2026-07-29T08:30:00.000Z", false);

  assert.match(refreshed, /令牌刷新并验证成功/);
  assert.match(refreshed, /过期倒计时已重新开始/);
  assert.match(verifiedOnly, /当前令牌发送验证成功/);
  assert.match(verifiedOnly, /不会重置过期倒计时/);
});

test("buildContextTokenUpdatedMessage confirms a verified new token without exposing setup details", () => {
  const message = buildContextTokenUpdatedMessage("2026-07-29T08:30:00.000Z");

  assert.match(message, /微信通知令牌刷新并验证成功/);
  assert.match(message, /新的 context token/);
  assert.match(message, /无需重新扫码/);
  assert.match(message, /重要邮件/);
  assert.match(message, /次重要邮件/);
  assert.match(message, /07\/29/);
});
