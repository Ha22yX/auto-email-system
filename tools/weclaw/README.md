# Project-managed WeChat bridge

This directory keeps the WeClaw provenance and optional legacy binaries used while building the auto email system's WeChat notification bridge.

- Upstream: https://github.com/fastclaw-ai/weclaw
- Version: v0.7.1
- License: see `LICENSE`
- Integrity file: `checksums.txt`

## Current runtime

The production notification path is implemented directly in `server/src/weclaw/manager.ts` with Node.js calls to the WeChat iLink endpoints.

- QR login
- credential persistence in `~/.weclaw/accounts`
- context token persistence in `~/.weclaw/context_tokens.json`
- long-poll monitoring to refresh context tokens
- direct outgoing notification send

This means Linux deployments do not require a WeClaw executable. The optional binaries are only kept for upstream traceability and legacy cleanup.

Runtime logs are written outside this vendored directory at:

```text
data/weclaw.log
```
