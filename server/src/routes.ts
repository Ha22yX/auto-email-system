import express from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { classifyEmail } from "./ai";
import { clearAuthCookie, isAuthenticated, requireAuth, setAuthCookie } from "./auth";
import { handleAppEvents } from "./events";
import { fetchRemoteEmailImage, findInlineEmailImage } from "./email/assets";
import { fetchUnreadImap } from "./email/imap";
import { fetchUnreadPop3 } from "./email/pop3";
import { isProcessorRunning, processMailboxes } from "./email/processor";
import { checkLoginAllowed, registerLoginFailure, registerLoginSuccess } from "./security";
import {
  publicAiSettings,
  publicAuthSettings,
  publicMailbox,
  getDashboardData,
  getProcessedEmailById,
  queryProcessedEmails,
  readState,
  removeMailbox,
  updateAuthPassword,
  updateAiSettings,
  updateNotificationSettings,
  updateProcessedEmailPanelRead,
  updateSystemSettings,
  upsertMailbox,
  verifyAdminPassword
} from "./store";
import { sendClawbotTestNotification } from "./notifications/clawbot";
import { schedulePendingEmailNotificationRetry } from "./notifications/pending";
import {
  defaultWeclawApiUrl,
  getWeclawLogTail,
  getWeclawStatus,
  rebindWeclaw,
  startWeclaw,
  stopWeclaw
} from "./weclaw/manager";
import type { MailCategory } from "./types";

const router = express.Router();
const EMAIL_ASSET_TOKEN_TTL_SECONDS = 6 * 60 * 60;

const mailboxSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1, "请输入邮箱名称"),
  email: z.string().email("请输入正确邮箱地址"),
  protocol: z.enum(["imap", "pop3"]),
  host: z.string().min(1, "请输入服务器地址"),
  port: z.coerce.number().int().positive(),
  secure: z.coerce.boolean(),
  username: z.string().min(1, "请输入用户名"),
  password: z.string().optional().default(""),
  folder: z.string().optional().default("INBOX"),
  enabled: z.coerce.boolean()
});

const aiSchema = z.object({
  providerName: z.string().min(1),
  baseUrl: z.string().url(),
  apiKey: z.string().optional().default(""),
  model: z.string().min(1),
  temperature: z.coerce.number().min(0).max(2),
  multimodalEnabled: z.coerce.boolean().optional().default(true),
  multimodalBaseUrl: z.string().url().optional().default("https://open.bigmodel.cn/api/paas/v4/chat/completions"),
  multimodalModel: z.string().min(1).optional().default("glm-5v-turbo"),
  multimodalMaxAttachmentMb: z.coerce.number().min(1).max(32).optional().default(8),
  multimodalMaxTotalMb: z.coerce.number().min(1).max(64).optional().default(18)
});

const systemSchema = z.object({
  autoProcessEnabled: z.coerce.boolean(),
  autoLoadRemoteImages: z.coerce.boolean().optional().default(false),
  pollIntervalMinutes: z.coerce.number().int().min(1).max(1440),
  processLimitPerMailbox: z.coerce.number().int().min(1).max(500)
});

const notificationSchema = z.object({
  enabled: z.coerce.boolean(),
  clawbotRecipientId: z.string().optional().default(""),
  clawbotApiUrl: z.string().optional().default(defaultWeclawApiUrl),
  importantOnly: z.coerce.boolean().optional().default(true),
  notifyCategories: z
    .object({
      important: z.coerce.boolean().default(true),
      secondary: z.coerce.boolean().default(true),
      ignore: z.coerce.boolean().default(false)
    })
    .default({
      important: true,
      secondary: true,
      ignore: false
    })
});

const panelReadSchema = z.object({
  panelRead: z.coerce.boolean()
});

const loginSchema = z.object({
  password: z.string().min(1, "请输入登录密码")
});

const authPasswordSchema = z.object({
  currentPassword: z.string().min(1, "请输入当前密码"),
  newPassword: z.string().min(8, "新密码至少 8 位")
});

function asyncRoute(
  handler: (req: express.Request, res: express.Response) => Promise<unknown> | unknown
) {
  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    try {
      await handler(req, res);
    } catch (error) {
      next(error);
    }
  };
}

function emailListItem(email: ReturnType<typeof readState>["emails"][number]) {
  return {
    id: email.id,
    mailboxId: email.mailboxId,
    subject: email.subject,
    fromName: email.fromName,
    fromAddress: email.fromAddress,
    receivedAt: email.receivedAt,
    processedAt: email.processedAt,
    category: email.category,
    summaryZh: email.summaryZh,
    reasonZh: email.reasonZh,
    actionItemsZh: email.actionItemsZh,
    panelRead: email.panelRead ?? email.category === "ignore",
    panelReadAt: email.panelReadAt,
    readMarked: email.readMarked,
    readMarkNote: email.readMarkNote
  };
}

function emailDetailItem(email: ReturnType<typeof readState>["emails"][number]) {
  return {
    ...email,
    panelRead: email.panelRead ?? email.category === "ignore",
    assetToken: createEmailAssetToken(email.id)
  };
}

function base64Url(value: Buffer | string) {
  return Buffer.from(value).toString("base64url");
}

function fromBase64Url(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function emailAssetSigningKey() {
  const auth = readState().settings.auth;
  return `${auth.passwordHash}.${auth.passwordSalt}.${auth.passwordIterations}`;
}

function signEmailAssetPayload(payload: string) {
  return createHmac("sha256", emailAssetSigningKey()).update(payload).digest("base64url");
}

function createEmailAssetToken(emailId: string) {
  const now = Math.floor(Date.now() / 1000);
  const payload = base64Url(
    JSON.stringify({
      emailId,
      exp: now + EMAIL_ASSET_TOKEN_TTL_SECONDS
    })
  );
  return `${payload}.${signEmailAssetPayload(payload)}`;
}

function verifyEmailAssetToken(emailId: string, token: string) {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;

  const expectedSignature = signEmailAssetPayload(payload);
  const expected = Buffer.from(expectedSignature, "base64url");
  const actual = Buffer.from(signature, "base64url");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;

  try {
    const parsed = JSON.parse(fromBase64Url(payload)) as { emailId?: string; exp?: number };
    return parsed.emailId === emailId && Boolean(parsed.exp && parsed.exp >= Math.floor(Date.now() / 1000));
  } catch {
    return false;
  }
}

function authorizeEmailAsset(req: express.Request, res: express.Response, emailId: string) {
  const token = String(req.query.token || "");
  if (!emailId || !verifyEmailAssetToken(emailId, token)) {
    res.status(401).json({ error: "图片访问令牌无效或已过期。" });
    return null;
  }

  const email = getProcessedEmailById(emailId);
  if (!email) {
    res.status(404).json({ error: "邮件不存在。" });
    return null;
  }
  return email;
}

function buildDashboard(mailboxId?: string) {
  const dashboard = getDashboardData(mailboxId);
  const { state } = dashboard;

  return {
    settings: {
      ai: publicAiSettings(state.settings.ai),
      system: state.settings.system,
      notification: state.settings.notification,
      auth: publicAuthSettings(state.settings.auth)
    },
    mailboxes: state.mailboxes.map(publicMailbox),
    counts: dashboard.counts,
    unreadCounts: dashboard.unreadCounts,
    total: dashboard.total,
    allTotal: dashboard.allTotal,
    recentEmails: dashboard.recentEmails.map(emailListItem),
    runs: state.runs.slice(0, 10),
    processorRunning: isProcessorRunning(),
    currentRun: dashboard.currentRun
  };
}

router.get(
  "/health",
  asyncRoute((_req, res) => {
    res.json({ ok: true, processorRunning: isProcessorRunning() });
  })
);

router.get(
  "/auth/session",
  asyncRoute((req, res) => {
    res.json({
      authenticated: isAuthenticated(req),
      auth: publicAuthSettings(readState().settings.auth)
    });
  })
);

router.post(
  "/auth/login",
  asyncRoute((req, res) => {
    if (!checkLoginAllowed(req, res)) return;

    const parsed = loginSchema.parse(req.body);
    if (!verifyAdminPassword(parsed.password)) {
      registerLoginFailure(req);
      res.status(401).json({ error: "登录密码不正确。" });
      return;
    }

    registerLoginSuccess(req);
    setAuthCookie(req, res);
    res.json({
      authenticated: true,
      auth: publicAuthSettings(readState().settings.auth)
    });
  })
);

router.post(
  "/auth/logout",
  asyncRoute((req, res) => {
    clearAuthCookie(req, res);
    res.json({ authenticated: false });
  })
);

router.get(
  "/email-assets/image",
  asyncRoute(async (req, res) => {
    const emailId = String(req.query.emailId || "");
    if (!authorizeEmailAsset(req, res, emailId)) return;

    const url = String(req.query.url || "");
    if (!url) {
      res.status(400).json({ error: "缺少图片地址。" });
      return;
    }

    sendImageAsset(res, await fetchRemoteEmailImage(url));
  })
);

router.get(
  "/emails/:id/inline-image",
  asyncRoute(async (req, res) => {
    const email = authorizeEmailAsset(req, res, String(req.params.id));
    if (!email) return;

    const cid = String(req.query.cid || "");
    if (!cid) {
      res.status(400).json({ error: "缺少内嵌图片 ID。" });
      return;
    }

    const asset = await findInlineEmailImage(email, cid);
    if (!asset) {
      res.status(404).json({ error: "内嵌图片不存在。" });
      return;
    }

    sendImageAsset(res, asset);
  })
);

router.use(requireAuth);

router.get("/events", handleAppEvents);

router.get(
  "/dashboard",
  asyncRoute((req, res) => {
    res.json(buildDashboard(String(req.query.mailboxId ?? "all")));
  })
);

router.get(
  "/settings/ai",
  asyncRoute((_req, res) => {
    res.json(publicAiSettings(readState().settings.ai));
  })
);

router.put(
  "/settings/ai",
  asyncRoute((req, res) => {
    const parsed = aiSchema.parse(req.body);
    res.json(publicAiSettings(updateAiSettings(parsed)));
  })
);

router.post(
  "/settings/ai/test",
  asyncRoute(async (req, res) => {
    const parsed = aiSchema.parse(req.body);
    const saved = readState().settings.ai;
    const settings = {
      ...parsed,
      apiKey: parsed.apiKey || saved.apiKey
    };

    if (!settings.apiKey.trim()) {
      res.status(400).json({ error: "请输入 API Key 后再测试。" });
      return;
    }

    const result = await classifyEmail(
      {
        mailboxId: "test",
        externalUid: "test",
        subject: "测试邮件：明天下午三点确认合同",
        fromName: "系统测试",
        fromAddress: "test@example.com",
        toText: "me@example.com",
        receivedAt: new Date().toISOString(),
        originalText:
          "这是一封用于测试 AI API 连通性的邮件。请判断它是否重要，并用中文返回简短概况。"
      },
      settings,
      { timeoutMs: 20000 }
    );

    res.json({
      ok: true,
      message: `AI API 测试成功，模型返回分类：${result.category}`,
      result
    });
  })
);

router.get(
  "/settings/system",
  asyncRoute((_req, res) => {
    res.json(readState().settings.system);
  })
);

router.put(
  "/settings/system",
  asyncRoute((req, res) => {
    const parsed = systemSchema.parse(req.body);
    res.json(updateSystemSettings(parsed));
  })
);

router.get(
  "/settings/auth",
  asyncRoute((_req, res) => {
    res.json(publicAuthSettings(readState().settings.auth));
  })
);

router.put(
  "/settings/auth/password",
  asyncRoute((req, res) => {
    const parsed = authPasswordSchema.parse(req.body);
    res.json(publicAuthSettings(updateAuthPassword(parsed.currentPassword, parsed.newPassword)));
  })
);

router.get(
  "/settings/notification",
  asyncRoute((_req, res) => {
    res.json(readState().settings.notification);
  })
);

router.put(
  "/settings/notification",
  asyncRoute((req, res) => {
    const parsed = notificationSchema.parse(req.body);
    res.json(updateNotificationSettings(parsed));
  })
);

router.post(
  "/settings/notification/test",
  asyncRoute(async (req, res) => {
    const parsed = notificationSchema.parse(req.body);
    await sendClawbotTestNotification(parsed);
    schedulePendingEmailNotificationRetry(500);
    res.json({
      ok: true,
      message: "微信 ClawBot 测试通知已发送。"
    });
  })
);

function notificationApiUrl() {
  return defaultWeclawApiUrl;
}

router.get(
  "/weclaw/status",
  asyncRoute(async (_req, res) => {
    res.json(await getWeclawStatus(notificationApiUrl()));
  })
);

router.post(
  "/weclaw/start",
  asyncRoute(async (_req, res) => {
    res.status(202).json(await startWeclaw(notificationApiUrl()));
  })
);

router.post(
  "/weclaw/stop",
  asyncRoute(async (_req, res) => {
    res.json(await stopWeclaw(notificationApiUrl()));
  })
);

router.post(
  "/weclaw/rebind",
  asyncRoute(async (_req, res) => {
    res.status(202).json(await rebindWeclaw(notificationApiUrl()));
  })
);

router.get(
  "/weclaw/logs",
  asyncRoute((req, res) => {
    res.json(getWeclawLogTail(Number(req.query.lines ?? 160)));
  })
);

router.get(
  "/mailboxes",
  asyncRoute((_req, res) => {
    res.json(readState().mailboxes.map(publicMailbox));
  })
);

router.post(
  "/mailboxes",
  asyncRoute((req, res) => {
    const parsed = mailboxSchema.parse(req.body);
    res.status(201).json(upsertMailbox(parsed).map(publicMailbox));
  })
);

router.put(
  "/mailboxes/:id",
  asyncRoute((req, res) => {
    const parsed = mailboxSchema.parse({ ...req.body, id: req.params.id });
    res.json(upsertMailbox(parsed).map(publicMailbox));
  })
);

router.delete(
  "/mailboxes/:id",
  asyncRoute((req, res) => {
    res.json({
      ok: true,
      state: {
        mailboxes: removeMailbox(String(req.params.id)).mailboxes.map(publicMailbox)
      }
    });
  })
);

router.post(
  "/mailboxes/:id/test",
  asyncRoute(async (req, res) => {
    const mailbox = readState().mailboxes.find((item) => item.id === req.params.id);
    if (!mailbox) {
      res.status(404).json({ error: "邮箱不存在" });
      return;
    }

    const result = mailbox.protocol === "imap"
      ? await fetchUnreadImap(mailbox, 1)
      : await fetchUnreadPop3(mailbox, 1);

    res.json({
      ok: true,
      message: result.length
        ? `连接成功，并找到 ${result.length} 封待处理邮件。`
        : "连接成功，当前没有新的待处理邮件。"
    });
  })
);

router.get(
  "/emails",
  asyncRoute((req, res) => {
    const category = String(req.query.category ?? "");
    const mailboxId = String(req.query.mailboxId ?? "all");
    const q = String(req.query.q ?? "").trim().toLowerCase();
    const offset = Math.max(0, Math.floor(Number(req.query.offset ?? 0) || 0));
    const limit = Math.min(100, Math.max(20, Math.floor(Number(req.query.limit ?? 40) || 40)));
    const allowedCategories = new Set(["important", "secondary", "ignore"]);

    const result = queryProcessedEmails({
      category: allowedCategories.has(category) ? category : undefined,
      mailboxId,
      q,
      offset,
      limit
    });
    const items = result.items.map(emailListItem);
    res.json({
      items,
      total: result.total,
      offset,
      limit,
      hasMoreBefore: result.hasMoreBefore,
      hasMoreAfter: result.hasMoreAfter
    });
  })
);

function sendImageAsset(res: express.Response, asset: { content: Buffer; contentType: string }) {
  res.setHeader("Content-Type", asset.contentType);
  res.setHeader("Content-Length", asset.content.length);
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.end(asset.content);
}

router.get(
  "/email-assets/image",
  asyncRoute(async (req, res) => {
    const url = String(req.query.url || "");
    if (!url) {
      res.status(400).json({ error: "缺少图片地址" });
      return;
    }

    sendImageAsset(res, await fetchRemoteEmailImage(url));
  })
);

router.get(
  "/emails/:id/inline-image",
  asyncRoute(async (req, res) => {
    const email = getProcessedEmailById(String(req.params.id));
    if (!email) {
      res.status(404).json({ error: "邮件不存在" });
      return;
    }

    const cid = String(req.query.cid || "");
    if (!cid) {
      res.status(400).json({ error: "缺少内嵌图片 ID" });
      return;
    }

    const asset = await findInlineEmailImage(email, cid);
    if (!asset) {
      res.status(404).json({ error: "内嵌图片不存在" });
      return;
    }

    sendImageAsset(res, asset);
  })
);

router.get(
  "/emails/:id",
  asyncRoute((req, res) => {
    const email = getProcessedEmailById(String(req.params.id));
    if (!email) {
      res.status(404).json({ error: "邮件不存在" });
      return;
    }
    res.json(emailDetailItem(email));
  })
);

router.patch(
  "/emails/:id/read-state",
  asyncRoute((req, res) => {
    const parsed = panelReadSchema.parse(req.body);
    const email = updateProcessedEmailPanelRead(String(req.params.id), parsed.panelRead);
    if (!email) {
      res.status(404).json({ error: "邮件不存在" });
      return;
    }
    res.json(emailDetailItem(email));
  })
);

router.get(
  "/runs",
  asyncRoute((_req, res) => {
    res.json(readState().runs);
  })
);

router.post(
  "/process/run",
  asyncRoute(async (req, res) => {
    const run = await processMailboxes({ mailboxId: req.body?.mailboxId });
    res.status(202).json(run);
  })
);

router.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: "参数错误", details: error.flatten() });
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  const statusCode = typeof (error as { statusCode?: unknown })?.statusCode === "number"
    ? Number((error as { statusCode: number }).statusCode)
    : 500;
  res.status(statusCode >= 400 && statusCode < 600 ? statusCode : 500).json({ error: message });
});

export default router;
