import type { ImapFlow } from "imapflow";
import { readState, updateMailboxSync } from "../store";
import type { Mailbox } from "../types";
import { createImapClient } from "./imap";
import { requestMailboxProcessing } from "./processor";

type IdleWatcher = {
  mailboxId: string;
  fingerprint: string;
  client?: ImapFlow;
  stopped: boolean;
  reconnectAttempts: number;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  debounceTimer?: ReturnType<typeof setTimeout>;
  lastExists?: number;
};

const watchers = new Map<string, IdleWatcher>();
let reconcileTimer: ReturnType<typeof setInterval> | undefined;

function mailboxFingerprint(mailbox: Mailbox) {
  return [
    mailbox.id,
    mailbox.enabled,
    mailbox.protocol,
    mailbox.host,
    mailbox.port,
    mailbox.secure,
    mailbox.username,
    mailbox.password,
    mailbox.folder || "INBOX",
    mailbox.updatedAt
  ].join("\n");
}

function clearWatcherTimers(watcher: IdleWatcher) {
  if (watcher.reconnectTimer) {
    clearTimeout(watcher.reconnectTimer);
    watcher.reconnectTimer = undefined;
  }
  if (watcher.debounceTimer) {
    clearTimeout(watcher.debounceTimer);
    watcher.debounceTimer = undefined;
  }
}

async function closeWatcher(watcher: IdleWatcher) {
  watcher.stopped = true;
  clearWatcherTimers(watcher);
  const client = watcher.client;
  watcher.client = undefined;
  if (!client) return;
  try {
    await client.logout();
  } catch {
    try {
      client.close();
    } catch {
      // Connection is already gone.
    }
  }
}

function scheduleMailboxScan(watcher: IdleWatcher, delayMs = 5000) {
  if (watcher.stopped) return;
  if (watcher.debounceTimer) clearTimeout(watcher.debounceTimer);
  watcher.debounceTimer = setTimeout(() => {
    watcher.debounceTimer = undefined;
    requestMailboxProcessing(watcher.mailboxId, 0);
  }, delayMs);
}

function scheduleReconnect(watcher: IdleWatcher, reason: string) {
  if (watcher.stopped) return;
  const delayMs = Math.min(60000, 5000 * Math.max(1, watcher.reconnectAttempts + 1));
  watcher.reconnectAttempts += 1;
  updateMailboxSync(watcher.mailboxId, {
    lastError: `IMAP 实时监听中断，${Math.round(delayMs / 1000)} 秒后重连。${reason}`
  });
  if (watcher.reconnectTimer) clearTimeout(watcher.reconnectTimer);
  watcher.reconnectTimer = setTimeout(() => {
    watcher.reconnectTimer = undefined;
    void connectWatcher(watcher);
  }, delayMs);
}

async function connectWatcher(watcher: IdleWatcher) {
  if (watcher.stopped) return;

  const mailbox = readState().mailboxes.find((item) => item.id === watcher.mailboxId);
  if (!mailbox || !mailbox.enabled || mailbox.protocol !== "imap") {
    await closeWatcher(watcher);
    watchers.delete(watcher.mailboxId);
    return;
  }

  try {
    const client = createImapClient(mailbox, {
      socketTimeout: 8 * 60 * 1000,
      maxIdleTime: 4 * 60 * 1000,
      missingIdleCommand: "NOOP"
    });
    watcher.client = client;

    client.on("exists", (event) => {
      const count = Number(event.count || 0);
      const previous = watcher.lastExists ?? 0;
      watcher.lastExists = count;
      if (count > previous) {
        scheduleMailboxScan(watcher, 3000);
      }
    });

    client.on("error", (error) => {
      if (!watcher.stopped) {
        updateMailboxSync(watcher.mailboxId, { lastError: `IMAP 实时监听错误：${error.message}` });
      }
    });

    client.on("close", () => {
      watcher.client = undefined;
      scheduleReconnect(watcher, "连接已关闭。");
    });

    await client.connect();
    const previousExists = watcher.lastExists;
    const opened = await client.mailboxOpen(mailbox.folder || "INBOX");
    watcher.lastExists = opened.exists;
    watcher.reconnectAttempts = 0;
    updateMailboxSync(watcher.mailboxId, {
      lastError: ""
    });

    // Catch messages that arrived while reconnecting without creating empty progress runs.
    if (previousExists !== undefined && opened.exists > previousExists) {
      requestMailboxProcessing(watcher.mailboxId, 2000);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (watcher.client) {
      try {
        watcher.client.close();
      } catch {
        // Ignore close errors during failed connect.
      }
      watcher.client = undefined;
    }
    scheduleReconnect(watcher, message);
  }
}

function startWatcher(mailbox: Mailbox) {
  const watcher: IdleWatcher = {
    mailboxId: mailbox.id,
    fingerprint: mailboxFingerprint(mailbox),
    stopped: false,
    reconnectAttempts: 0
  };
  watchers.set(mailbox.id, watcher);
  void connectWatcher(watcher);
}

async function replaceWatcher(existing: IdleWatcher, mailbox: Mailbox) {
  await closeWatcher(existing);
  watchers.delete(existing.mailboxId);
  startWatcher(mailbox);
}

async function reconcileWatchers() {
  const state = readState();
  const enabledImap = state.settings.system.autoProcessEnabled
    ? state.mailboxes.filter((mailbox) => mailbox.enabled && mailbox.protocol === "imap")
    : [];
  const wantedIds = new Set(enabledImap.map((mailbox) => mailbox.id));

  for (const [id, watcher] of watchers) {
    if (!wantedIds.has(id)) {
      await closeWatcher(watcher);
      watchers.delete(id);
    }
  }

  for (const mailbox of enabledImap) {
    const fingerprint = mailboxFingerprint(mailbox);
    const existing = watchers.get(mailbox.id);
    if (!existing) {
      startWatcher(mailbox);
      continue;
    }
    if (existing.fingerprint !== fingerprint) {
      await replaceWatcher(existing, mailbox);
    }
  }
}

export function startImapIdleWatchers() {
  if (reconcileTimer) return reconcileTimer;
  void reconcileWatchers();
  reconcileTimer = setInterval(() => {
    void reconcileWatchers();
  }, 60000);
  return reconcileTimer;
}
