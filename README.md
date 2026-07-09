# 自动邮件系统

一个本地运行的自动邮件处理系统：后台读取 IMAP/POP3 邮箱，调用 AI 判断邮件重要程度，把系统处理过的邮件标记为已处理，并在网页面板中按「重要」「次重要」「不用管」三类展示。

## 已实现功能

- 多邮箱管理，支持 IMAP 与 POP3。
- IMAP 读取未读邮件后会自动追加 `\Seen`，也就是服务端已读标记。
- POP3 没有标准已读概念，系统会用 UIDL 在本地记录「已处理」，不会删除邮件。
- 默认 AI 配置为智谱 GLM Coding Plan：
  - Anthropic Message Base URL: `https://open.bigmodel.cn/api/anthropic`
  - OpenAI Chat Completion Base URL: `https://open.bigmodel.cn/api/coding/paas/v4`
  - Model: `glm-5.2`
- 管理面板可修改 AI Base URL、模型、API Key、邮箱账号、轮询间隔。
- 邮件列表展示中文概况，详情页展示中文概况、判断理由、建议动作和邮件原件。
- 本地数据存储在 `data/app.db.json`，该目录已加入 `.gitignore`，不会提交邮箱密码和 API Key。

## 本地运行

```bash
npm install
npm run build
npm run start
```

打开：

```text
http://127.0.0.1:8787
```

开发模式：

```bash
npm run dev
```

前端默认在 `http://127.0.0.1:5173`，后端 API 默认在 `http://127.0.0.1:8787`。

## 微信 WeClaw 通知

项目保留 WeClaw 的账号目录和二维码登录协议，但通知发送由本项目内置的轻量桥接完成。
打开“管理设置”里的“微信通知 / ClawBot 推送”，可以直接启动、停止和查看桥接日志。
首次启动时，请根据日志提示用手机微信扫码登录。

WeClaw 来源：https://github.com/fastclaw-ai/weclaw
其许可证保存在 `tools/weclaw/LICENSE`。

扫码登录后，接收人会自动绑定为扫码微信；首次发送通知前，请在微信里打开 ClawBot 联系人并发送任意一条消息，用于建立会话上下文。桥接只记录 `context_token`，不会把你的微信消息转发给 Claude/Codex，也不会自动回复。之后 token 会保存到 `~/.weclaw/context_tokens.json`，重启后继续可用。

服务启动时会自动启动项目内通知桥接。管理面板里的“重新绑定微信”会停止当前桥接、清理 `~/.weclaw/accounts/*.json` 和 `~/.weclaw/context_tokens.json`，然后重新生成扫码二维码。

## 配置步骤

1. 打开「管理设置」。
2. 在 AI API 中填入智谱 API Key。留空时系统会使用规则兜底分类，方便先测试界面。
3. 在「添加邮箱」里填写邮箱服务器信息。
4. 保存邮箱后可点击插头按钮测试连接。
5. 回到「处理台」点击「立即处理」，或开启自动处理后等待轮询。

## 常见邮箱端口

- IMAP SSL/TLS: `993`
- POP3 SSL/TLS: `995`
- IMAP 非加密: `143`
- POP3 非加密: `110`

多数邮箱需要在邮箱后台开启 IMAP/POP3，并使用「授权码」而不是登录密码。

## 注意

本项目是本地自托管系统。`data/` 内保存了邮箱授权码和 AI Key，请不要手动提交该目录，也不要把运行目录共享给不可信用户。
