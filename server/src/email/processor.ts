import { randomUUID } from "node:crypto";
import { classifyEmail } from "../ai";
import {
  analyzeEmailAttachments,
  hasMultimodalWork,
  stripAttachmentContent,
  withMultimodalContext
} from "../multimodal";
import {
  addProcessedEmail,
  addRun,
  getProcessedEmail,
  readState,
  updateMailboxSync,
  updateProcessedEmailNotification,
  updateProcessedEmailReadMark,
  updateRun
} from "../store";
import { sendEmailNotification, shouldNotifyEmail } from "../notifications/clawbot";
import type { Mailbox, ProcessingRun } from "../types";
import { countUnreadImap, fetchInterruptedImapRecovery, fetchUnreadImap, type FetchedEmail } from "./imap";
import { countUnreadPop3, fetchUnreadPop3 } from "./pop3";

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

async function countForMailbox(mailbox: Mailbox, limit: number) {
  if (mailbox.protocol === "imap") {
    return countUnreadImap(mailbox, limit);
  }
  return countUnreadPop3(mailbox, limit);
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
    totalMailboxCount: 0,
    currentMailboxIndex: 0,
    currentStage: "准备读取邮箱",
    totalTaskCount: 0,
    handledTaskCount: 0,
    totalUnreadCount: 0,
    handledUnreadCount: 0,
    currentMailboxUnreadCount: 0,
    currentMailboxHandledCount: 0,
    currentEmailStep: "",
    currentEmailStepIndex: 0,
    currentEmailStepTotal: 0,
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
    run.totalMailboxCount = mailboxes.length;
    persistRun(run);

    const unreadCountByMailbox = new Map<string, number>();
    persistRun(run, { currentStage: "正在统计本轮未读邮件" });
    for (const [index, mailbox] of mailboxes.entries()) {
      try {
        persistRun(run, {
          currentMailboxIndex: index + 1,
          currentMailboxName: mailbox.name,
          currentStage: "正在统计本轮未读邮件"
        });
        const count = await withTimeout(
          countForMailbox(mailbox, state.settings.system.processLimitPerMailbox),
          45000,
          `${mailbox.name}: 统计未读邮件超时`
        );
        unreadCountByMailbox.set(mailbox.id, count);
        run.totalUnreadCount = (run.totalUnreadCount ?? 0) + count;
        run.totalTaskCount = (run.totalTaskCount ?? 0) + count;
        persistRun(run);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        unreadCountByMailbox.set(mailbox.id, 0);
        run.errors.push(`${mailbox.name}: 统计未读邮件失败，仍会尝试读取。${message}`);
        persistRun(run);
      }
    }

    const processFetchedItem = async (mailbox: Mailbox, item: FetchedEmail, recovered = false) => {
      const currentStepTotal = hasMultimodalWork(item.email, state.settings.ai) ? 5 : 4;
      persistRun(run, {
        currentMailboxName: mailbox.name,
        currentSubject: item.email.subject,
        currentStage: "正在检查处理记录",
        currentEmailStep: "检查处理记录",
        currentEmailStepIndex: 1,
        currentEmailStepTotal: currentStepTotal
      });

      const existing = getProcessedEmail(item.email.mailboxId, item.email.externalUid);
      if (existing) {
        try {
          persistRun(run, {
            currentStage: "邮件已在数据库中，正在补标已读",
            currentEmailStep: "补标已读",
            currentEmailStepIndex: currentStepTotal,
            currentEmailStepTotal: currentStepTotal
          });
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

      let emailForClassification = item.email;
      let classification;
      try {
        if (currentStepTotal === 5) {
          persistRun(run, {
            currentStage: "正在识别内嵌图片/PDF",
            currentEmailStep: "多模态识别",
            currentEmailStepIndex: 2,
            currentEmailStepTotal: currentStepTotal
          });
          const multimodalAnalysis = await analyzeEmailAttachments(item.email, state.settings.ai, { timeoutMs: 90000 });
          emailForClassification = withMultimodalContext(item.email, multimodalAnalysis);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        run.errors.push(`${mailbox.name}: 多模态识别失败，邮件保持未读，稍后可重新处理。${message}`);
        persistRun(run, {
          currentStage: "多模态识别失败，邮件保持未读",
          currentEmailStep: "等待重试",
          currentEmailStepIndex: 2,
          currentEmailStepTotal: currentStepTotal
        });
        return;
      }

      try {
        persistRun(run, {
          currentStage: recovered ? "正在恢复并请求 AI 分类" : "正在请求 AI 分类",
          currentEmailStep: "AI 分类",
          currentEmailStepIndex: currentStepTotal === 5 ? 3 : 2,
          currentEmailStepTotal: currentStepTotal
        });
        classification = await classifyEmail(emailForClassification, state.settings.ai, { timeoutMs: 45000 });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        run.errors.push(`${mailbox.name}: AI 分类失败，邮件保持未读，稍后可重新处理。${message}`);
        persistRun(run, {
          currentStage: "AI 分类失败，邮件保持未读",
          currentEmailStep: "等待重试",
          currentEmailStepIndex: currentStepTotal === 5 ? 3 : 2,
          currentEmailStepTotal: currentStepTotal
        });
        return;
      }

      const processedEmail = {
        id: randomUUID(),
        ...stripAttachmentContent({
          ...item.email,
          multimodalAnalysis: emailForClassification.multimodalAnalysis
        }),
        processedAt: new Date().toISOString(),
        category: classification.category,
        summaryZh: recovered ? `[中断恢复] ${classification.summaryZh}` : classification.summaryZh,
        reasonZh: recovered
          ? `这封邮件来自旧处理任务中断后的恢复扫描。${classification.reasonZh}`
          : classification.reasonZh,
        actionItemsZh: classification.actionItemsZh,
        panelRead: classification.category === "ignore",
        panelReadAt: classification.category === "ignore" ? new Date().toISOString() : undefined,
        readMarked: false,
        readMarkNote: "已写入数据库，正在标记已读。"
      };
      const insertedEmail = addProcessedEmail(processedEmail);
      incrementRun(run, classification.category);
      persistRun(run, {
        currentStage: "已写入数据库，正在标记已读",
        currentEmailStep: "写入数据库",
        currentEmailStepIndex: currentStepTotal === 5 ? 4 : 3,
        currentEmailStepTotal: currentStepTotal
      });

      if (insertedEmail && shouldNotifyEmail(state.settings.notification, insertedEmail)) {
        try {
          persistRun(run, {
            currentStage: "重要邮件已入库，正在发送微信通知",
            currentEmailStep: "微信通知",
            currentEmailStepIndex: currentStepTotal === 5 ? 4 : 3,
            currentEmailStepTotal: currentStepTotal
          });
          await withTimeout(
            sendEmailNotification(state.settings.notification, insertedEmail, mailbox),
            20000,
            "微信 ClawBot 通知超时"
          );
          updateProcessedEmailNotification(insertedEmail.id, {
            notifiedAt: new Date().toISOString(),
            notificationError: ""
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          updateProcessedEmailNotification(insertedEmail.id, {
            notifiedAt: undefined,
            notificationError: message
          });
          run.errors.push(`${mailbox.name}: 重要邮件微信通知失败。${message}`);
          persistRun(run);
        }
      }

      try {
        persistRun(run, {
          currentStage: "已写入数据库，正在标记已读",
          currentEmailStep: "标记已读",
          currentEmailStepIndex: currentStepTotal,
          currentEmailStepTotal: currentStepTotal
        });
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
      persistRun(run, {
        currentStage: `已处理 ${run.processedCount} 封`,
        currentEmailStep: "完成",
        currentEmailStepIndex: currentStepTotal,
        currentEmailStepTotal: currentStepTotal
      });
    };

    for (const [index, mailbox] of mailboxes.entries()) {
      try {
        persistRun(run, {
          currentMailboxIndex: index + 1,
          currentMailboxName: mailbox.name,
          currentSubject: undefined,
          currentStage: "正在读取未读邮件",
          currentMailboxUnreadCount: unreadCountByMailbox.get(mailbox.id) ?? 0,
          currentMailboxHandledCount: 0,
          currentEmailStep: "",
          currentEmailStepIndex: 0,
          currentEmailStepTotal: 0
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
            try {
              const recoveryItems = await withTimeout(
                fetchInterruptedImapRecovery(mailbox, {
                  afterUid: maxProcessedUid,
                  uidWindow: 5000,
                  limit: 5
                }),
                45000,
                `${mailbox.name}: 中断恢复扫描超时`
              );
              if (recoveryItems.length) {
                run.totalTaskCount = (run.totalTaskCount ?? 0) + recoveryItems.length;
                persistRun(run);
              }

              for (const item of recoveryItems) {
                await processFetchedItem(mailbox, item, true);
                run.handledTaskCount = (run.handledTaskCount ?? 0) + 1;
                persistRun(run);
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              persistRun(run, {
                currentStage: `${message}，已跳过恢复扫描并继续读取未读邮件`
              });
            }
          }
        }

        const fetched = await withTimeout(
          fetchForMailbox(mailbox, state.settings.system.processLimitPerMailbox),
          120000,
          `${mailbox.name}: 读取邮箱超时`
        );
        const expectedUnreadCount = unreadCountByMailbox.get(mailbox.id) ?? 0;
        if (fetched.length > expectedUnreadCount) {
          const additionalUnread = fetched.length - expectedUnreadCount;
          run.totalUnreadCount = (run.totalUnreadCount ?? 0) + additionalUnread;
          run.currentMailboxUnreadCount = (run.currentMailboxUnreadCount ?? 0) + additionalUnread;
          run.totalTaskCount = (run.totalTaskCount ?? 0) + additionalUnread;
          persistRun(run);
        }

        for (const item of fetched) {
          await processFetchedItem(mailbox, item);
          run.handledTaskCount = (run.handledTaskCount ?? 0) + 1;
          run.handledUnreadCount = (run.handledUnreadCount ?? 0) + 1;
          run.currentMailboxHandledCount = (run.currentMailboxHandledCount ?? 0) + 1;
          persistRun(run);
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
