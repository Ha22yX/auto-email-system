# Local WeClaw Patches

The bundled Windows AMD64 runtime is based on upstream `fastclaw-ai/weclaw` v0.7.1 with a small local patch for this email system.

## Context Token Persistence

WeChat iLink requires `context_token` on outgoing `sendmessage` calls. The upstream HTTP `/api/send` route accepted only `to` and `text`/`media_url`, then sent with an empty context token, which can fail with:

```text
send message failed: ret=-2 errmsg=
```

The bundled runtime now:

- Records the latest `context_token` whenever the bound WeChat user sends a message to ClawBot.
- Persists tokens to `~/.weclaw/context_tokens.json`, so restarts keep the send context.
- Uses the stored token for HTTP `/api/send` and CLI `weclaw send`.
- Returns HTTP `409` with an activation hint when no context token exists yet.

After first login, open the ClawBot contact in WeChat and send any short message once. From then on, proactive email notifications can use the stored context.

## Current Project Bridge

The email system now sends notifications through its own Node iLink bridge instead of keeping the WeClaw agent bridge running. Incoming WeChat messages are only used to refresh `context_token`; they are not forwarded to Claude/Codex and do not receive automatic replies.
