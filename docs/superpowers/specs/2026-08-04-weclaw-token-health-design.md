# WeClaw Token Health Design

## Problem

The current bridge treats every inbound WeChat message as a full 24-hour token renewal. It stores one `token_updated_at` timestamp and reports `contextReady` whenever a token string exists. Production logs show that proactive sends can already fail with `ret=-2 / prepare failed` before the reminder scheduled for hour 23, leaving the reminder unable to notify the user through the same expired token.

## Goals

- Separate token capture, successful verification, and failed delivery timestamps.
- Never report a token as healthy after its current token hash has produced a terminal iLink send failure.
- Send the proactive refresh reminder four hours before the nominal 24-hour window so the reminder still has a practical chance to arrive.
- Keep failed email notifications queued and retry them after a later inbound message restores a verified context.
- Expose concise token health information to the management panel without exposing token values.

## State Model

Each recipient stores metadata for the current token hash:

- `captured_at`: when this exact token value was first captured; this anchors the conservative expiry estimate.
- `observed_at`: last inbound message carrying this token, even when the value is unchanged.
- `verified_at`: last successful direct send using this token.
- `failed_at`: last terminal send rejection using this token.
- `last_error`: sanitized rejection summary.

Legacy `token_updated_at` remains readable for migration. On first write, the new metadata is persisted next to existing token data. A new token resets `captured_at` and clears reminder and failure state. The same token updates only `observed_at`: it neither extends the estimated lifetime nor clears a reminder or recorded send failure.

## Health Rules

- `missing`: no token is stored.
- `invalid`: the current token has a send failure newer than its successful verification.
- `expired`: the last capture is at least 24 hours old.
- `refresh-soon`: the last capture is at least 20 hours old.
- `healthy`: the token has a successful verification newer than any failure and is younger than 20 hours.
- `unverified`: a token was captured but has not completed a successful direct send.

`contextReady` is true only for `healthy` and `refresh-soon`.

## Reminder Behavior

The default reminder lead changes from one hour to four hours. The reminder worker uses the current token's metadata and records both success and failure. A terminal failure immediately changes health to `invalid`; it is retried only after a new inbound context is captured or at the existing throttled interval for transient errors.

The confirmation is sent only after the captured token is accepted by a direct send. Successful confirmation records `verified_at`. Failed confirmation records `failed_at` and must not claim success. Its wording distinguishes a genuinely new token from a same-token liveness check, so the latter never claims that expiry was extended.

## UI

The management panel shows a status label and compact details: last capture, last verification, estimated expiry, and the most recent failure. The copy uses “estimated” for expiry because iLink does not publish a reliable per-token expiration timestamp.

## Testing

- Pure tests cover health derivation at healthy, refresh-soon, expired, invalid, and unverified boundaries.
- Store tests cover same-token capture without extending lifetime or clearing reminders/failures, plus successful verification clearing a send failure.
- Reminder tests verify the four-hour default boundary without contacting iLink.
- Existing notification retry tests and the full application test suite must remain green.
