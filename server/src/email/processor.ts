import { randomUUID } from "node:crypto";
import { classifyEmail } from "../ai";
import {
  addProcessedEmail,
  addRun,
  readState,
  updateMailboxSync,
  updateState
} from "../store";
import type { Mailbox, ProcessingRun } from "../types";
import { fetchUnreadImap } from "./imap";
import { fetchUnreadPop3 } from "./pop3";

let running = false;

function incrementRun(run: ProcessingRun, category: "important" | "secondary" | "ignore") {
  run.processedCount += 1;
  if (category === "important") run.importantCount += 1;
  if (category === "secondary") run.secondaryCount += 1;
  if (category === "ignore") run.ignoreCount += 1;
}

async function fetchForMailbox(mailbox: Mailbox, limit: number) {
  if (mailbox.protocol === "imap") {
    return fetchUnreadImap(mailbox, limit);
  }
  return fetchUnreadPop3(mailbox, limit);
}

export async function processMailboxes(options: { mailboxId?: string; manual?: boolean } = {}) {
  if (running) {
    throw new Error("已有处理任务正在运行");
  }

  running = true;
  const state = readState();
  const run: ProcessingRun = {
    id: randomUUID(),
    startedAt: new Date().toISOString(),
    status: "running",
    mailboxId: options.mailboxId,
    processedCount: 0,
    importantCount: 0,
    secondaryCount: 0,
    ignoreCount: 0,
    errors: []
  };
  addRun(run);

  try {
    const mailboxes = state.mailboxes.filter((mailbox) => {
      if (!mailbox.enabled) return false;
      if (options.mailboxId) return mailbox.id === options.mailboxId;
      return true;
    });

    for (const mailbox of mailboxes) {
      try {
        const fetched = await fetchForMailbox(mailbox, state.settings.system.processLimitPerMailbox);
        for (const item of fetched) {
          let classification;
          try {
            classification = await classifyEmail(item.email, state.settings.ai);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            run.errors.push(`${mailbox.name}: AI 分类失败，已使用规则兜底。${message}`);
            classification = {
              category: "secondary" as const,
              summaryZh: `AI 分类失败，系统临时归入次重要。主题：“${item.email.subject || "无主题"}”。`,
              reasonZh: "AI 接口不可用或返回格式异常，需要稍后检查 API 设置。",
              actionItemsZh: ["检查管理面板中的 AI Base URL、模型和 API Key。"]
            };
          }

          const readMark = await item.markRead();
          addProcessedEmail({
            id: randomUUID(),
            ...item.email,
            processedAt: new Date().toISOString(),
            category: classification.category,
            summaryZh: classification.summaryZh,
            reasonZh: classification.reasonZh,
            actionItemsZh: classification.actionItemsZh,
            readMarked: readMark.marked,
            readMarkNote: readMark.note
          });
          incrementRun(run, classification.category);
        }

        updateMailboxSync(mailbox.id, {
          lastSyncAt: new Date().toISOString(),
          lastError: ""
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        run.errors.push(`${mailbox.name}: ${message}`);
        updateMailboxSync(mailbox.id, { lastError: message });
      }
    }

    run.status = run.errors.length ? "failed" : "success";
    run.finishedAt = new Date().toISOString();
    return run;
  } finally {
    updateState((draft) => {
      const existing = draft.runs.find((item) => item.id === run.id);
      if (existing) Object.assign(existing, run);
    });
    running = false;
  }
}

export function isProcessorRunning() {
  return running;
}

export function startProcessingWorker() {
  let lastAttemptAt = 0;

  const tick = async () => {
    const current = readState();
    if (!current.settings.system.autoProcessEnabled || running) return;
    if (!current.mailboxes.some((mailbox) => mailbox.enabled)) return;

    const intervalMs = Math.max(current.settings.system.pollIntervalMinutes, 1) * 60 * 1000;
    if (Date.now() - lastAttemptAt < intervalMs) return;
    lastAttemptAt = Date.now();

    try {
      await processMailboxes();
    } catch {
      // The run itself records detailed errors. The worker stays alive.
    }
  };

  const timer = setInterval(tick, 60 * 1000);
  void tick();
  return timer;
}
