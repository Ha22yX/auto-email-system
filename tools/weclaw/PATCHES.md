# Local WeChat Bridge Notes

The project originally bundled a patched upstream `fastclaw-ai/weclaw` v0.7.1 Windows runtime. The current implementation has moved the required bridge behavior into the Node backend so the app can run on Linux without a platform-specific WeClaw executable.

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

The email system sends notifications through its own Node iLink bridge instead of keeping the WeClaw agent bridge running. Incoming WeChat messages are only used to refresh `context_token`; they are not forwarded to Claude/Codex and do not receive automatic replies.
