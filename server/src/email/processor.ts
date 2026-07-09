import { randomUUID } from "node:crypto";
import { classifyEmail } from "../ai";
import {
  addProcessedEmail,
  addRun,
  getProcessedEmail,
  readState,
  updateMailboxSync,
  updateProcessedEmailReadMark,
  updateRun
} from "../store";
import type { Mailbox, ProcessingRun } from "../types";
import { fetchInterruptedImapRecovery, fetchUnreadImap, type FetchedEmail } from "./imap";
import { fetchUnreadPop3 } from "./pop3";

let running = false;

function incrementRun(run: ProcessingRun, category: "important" | "secondary" | "ignore") {
  run.processedCount += 1;
  if (category === "important") run.importantCount += 1;
  if (category === "secondary") run.secondaryCount += 1;
  if (category === "ignore") run.ignoreCount += 1;
}

function persistRun(run: ProcessingRun, patch: Partial<ProcessingRun> = {}) {
  Object.assign(run, patch);
  updateRun(run);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function fetchForMailbox(mailbox: Mailbox, limit: number) {
  if (mailbox.protocol === "imap") {
    return fetchUnreadImap(mailbox, limit);
  }
  return fetchUnreadPop3(mailbox, limit);
}

export async function processMailboxes(options: {
  mailboxId?: string;
  manual?: boolean;
  recoverInterrupted?: boolean;
} = {}) {
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
    currentStage: "准备读取邮箱",
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

    const processFetchedItem = async (mailbox: Mailbox, item: FetchedEmail, recovered = false) => {
      persistRun(run, {
        currentMailboxName: mailbox.name,
        currentSubject: item.email.subject,
        currentStage: "正在检查处理记录"
      });

      const existing = getProcessedEmail(item.email.mailboxId, item.email.externalUid);
      if (existing) {
        try {
          persistRun(run, { currentStage: "邮件已在数据库中，正在补标已读" });
          const readMark = await withTimeout(item.markRead(), 30000, "标记已读超时");
          updateProcessedEmailReadMark(item.email.mailboxId, item.email.externalUid, readMark);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          updateProcessedEmailReadMark(item.email.mailboxId, item.email.externalUid, {
            marked: false,
            note: message
          });
          run.errors.push(`${mailbox.name}: 已入库邮件补标已读失败。${message}`);
          persistRun(run);
        }
        return;
      }

      let classification;
      try {
        persistRun(run, { currentStage: recovered ? "正在恢复并请求 AI 分类" : "正在请求 AI 分类" });
        classification = await classifyEmail(item.email, state.settings.ai, { timeoutMs: 45000 });
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

      addProcessedEmail({
        id: randomUUID(),
        ...item.email,
        processedAt: new Date().toISOString(),
        category: classification.category,
        summaryZh: recovered ? `[中断恢复] ${classification.summaryZh}` : classification.summaryZh,
        reasonZh: recovered
          ? `这封邮件来自旧处理任务中断后的恢复扫描。${classification.reasonZh}`
          : classification.reasonZh,
        actionItemsZh: classification.actionItemsZh,
        readMarked: false,
        readMarkNote: "已写入数据库，正在标记已读。"
      });
      incrementRun(run, classification.category);
      persistRun(run, { currentStage: "已写入数据库，正在标记已读" });

      try {
        const readMark = await withTimeout(item.markRead(), 30000, "标记已读超时");
        updateProcessedEmailReadMark(item.email.mailboxId, item.email.externalUid, readMark);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        updateProcessedEmailReadMark(item.email.mailboxId, item.email.externalUid, {
          marked: false,
          note: message
        });
        run.errors.push(`${mailbox.name}: 邮件已入库，但标记已读失败。${message}`);
      }
      persistRun(run, { currentStage: `已处理 ${run.processedCount} 封` });
    };

    for (const mailbox of mailboxes) {
      try {
        persistRun(run, {
          currentMailboxName: mailbox.name,
          currentSubject: undefined,
          currentStage: "正在读取未读邮件"
        });

        if (options.recoverInterrupted && mailbox.protocol === "imap") {
          const processedUids = state.emails
            .filter((email) => email.mailboxId === mailbox.id)
            .map((email) => Number(email.externalUid))
            .filter((uid) => Number.isFinite(uid) && uid > 0);
          const maxProcessedUid = processedUids.length ? Math.max(...processedUids) : 0;

          if (maxProcessedUid > 0) {
            persistRun(run, {
              currentStage: "正在恢复旧任务可能遗漏的已读邮件"
            });
            const recoveryItems = await withTimeout(
              fetchInterruptedImapRecovery(mailbox, {
                afterUid: maxProcessedUid,
                uidWindow: 5000,
                limit: 5
              }),
              120000,
              `${mailbox.name}: 中断恢复扫描超时`
            );

            for (const item of recoveryItems) {
              await processFetchedItem(mailbox, item, true);
            }
          }
        }

        const fetched = await withTimeout(
          fetchForMailbox(mailbox, state.settings.system.processLimitPerMailbox),
          120000,
          `${mailbox.name}: 读取邮箱超时`
        );

        for (const item of fetched) {
          await processFetchedItem(mailbox, item);
        }

        updateMailboxSync(mailbox.id, {
          lastSyncAt: new Date().toISOString(),
          lastError: ""
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        run.errors.push(`${mailbox.name}: ${message}`);
        updateMailboxSync(mailbox.id, { lastError: message });
        persistRun(run, { currentStage: message });
      }
    }

    run.status = run.errors.length ? "failed" : "success";
    run.finishedAt = new Date().toISOString();
    run.currentStage = run.status === "success" ? "处理完成" : "处理完成，有错误";
    run.currentSubject = undefined;
    persistRun(run);
    return run;
  } finally {
    running = false;
    updateRun(run);
  }
}

export function isProcessorRunning() {
  return running;
}

export function startProcessingWorker(options: { recoverInterruptedOnFirstRun?: boolean } = {}) {
  let lastAttemptAt = 0;
  let shouldRecoverInterrupted = Boolean(options.recoverInterruptedOnFirstRun);

  const tick = async () => {
    const current = readState();
    if (!current.settings.system.autoProcessEnabled || running) return;
    if (!current.mailboxes.some((mailbox) => mailbox.enabled)) return;

    const intervalMs = Math.max(current.settings.system.pollIntervalMinutes, 1) * 60 * 1000;
    if (Date.now() - lastAttemptAt < intervalMs) return;
    lastAttemptAt = Date.now();

    try {
      await processMailboxes({ recoverInterrupted: shouldRecoverInterrupted });
      shouldRecoverInterrupted = false;
    } catch {
      // The run itself records detailed errors. The worker stays alive.
    }
  };

  const timer = setInterval(tick, 60 * 1000);
  void tick();
  return timer;
}
