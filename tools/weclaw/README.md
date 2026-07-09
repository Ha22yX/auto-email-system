# Project-managed WeClaw runtime

This directory vendors the WeClaw runtime used by the auto email system to send WeChat notifications.

- Upstream: https://github.com/fastclaw-ai/weclaw
- Version: v0.7.1
- Windows runtime: `bin/weclaw_windows_amd64.exe`
- License: see `LICENSE`
- Integrity file: `checksums.txt`

The backend starts this runtime with:

```bash
weclaw_windows_amd64.exe start -f
```

The managed process listens on the address derived from the notification setting, usually:

```text
127.0.0.1:18011
```

Runtime logs are written outside this vendored directory at:

```text
data/weclaw.log
```
