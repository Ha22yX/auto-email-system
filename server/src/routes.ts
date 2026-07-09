import express from "express";
import { z } from "zod";
import { classifyEmail } from "./ai";
import { fetchUnreadImap } from "./email/imap";
import { fetchUnreadPop3 } from "./email/pop3";
import { isProcessorRunning, processMailboxes } from "./email/processor";
import {
  publicAiSettings,
  publicMailbox,
  readState,
  removeMailbox,
  updateAiSettings,
  updateSystemSettings,
  upsertMailbox
} from "./store";
import type { MailCategory } from "./types";

const router = express.Router();

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
  temperature: z.coerce.number().min(0).max(2)
});

const systemSchema = z.object({
  autoProcessEnabled: z.coerce.boolean(),
  pollIntervalMinutes: z.coerce.number().int().min(1).max(1440),
  processLimitPerMailbox: z.coerce.number().int().min(1).max(500)
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
    readMarked: email.readMarked,
    readMarkNote: email.readMarkNote
  };
}

function buildDashboard(mailboxId?: string) {
  const state = readState();
  const emails = state.emails.filter((email) => !mailboxId || mailboxId === "all" || email.mailboxId === mailboxId);
  const counts: Record<MailCategory, number> = {
    important: 0,
    secondary: 0,
    ignore: 0
  };

  for (const email of emails) {
    counts[email.category] += 1;
  }

  return {
    settings: {
      ai: publicAiSettings(state.settings.ai),
      system: state.settings.system
    },
    mailboxes: state.mailboxes.map(publicMailbox),
    counts,
    total: emails.length,
    recentEmails: emails.slice(0, 8).map(emailListItem),
    runs: state.runs.slice(0, 10),
    processorRunning: isProcessorRunning()
  };
}

router.get(
  "/health",
  asyncRoute((_req, res) => {
    res.json({ ok: true, processorRunning: isProcessorRunning() });
  })
);

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
    const allowedCategories = new Set(["important", "secondary", "ignore"]);

    const emails = readState().emails.filter((email) => {
      if (allowedCategories.has(category) && email.category !== category) return false;
      if (mailboxId !== "all" && email.mailboxId !== mailboxId) return false;
      if (!q) return true;
      return `${email.subject}\n${email.fromName}\n${email.fromAddress}\n${email.summaryZh}`.toLowerCase().includes(q);
    });

    res.json(emails.map(emailListItem));
  })
);

router.get(
  "/emails/:id",
  asyncRoute((req, res) => {
    const email = readState().emails.find((item) => item.id === req.params.id);
    if (!email) {
      res.status(404).json({ error: "邮件不存在" });
      return;
    }
    res.json(email);
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
  res.status(500).json({ error: message });
});

export default router;
