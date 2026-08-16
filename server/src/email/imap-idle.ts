import type { ImapFlow } from "imapflow";
import { readMailboxes, readSettings, updateMailboxSync } from "../store";
import type { Mailbox } from "../types";
import { createImapClient } from "./imap";
import { requestMailboxProcessing } from "./processor";

type IdleWatcher = {
  mailboxId: string;
  fingerprint: string;
  client?: ImapFlow;
  stopped: boolean;
  connecting: boolean;
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

function scheduleMailboxScan(watcher: IdleWatcher, delayMs = 500) {
  if (watcher.stopped || watcher.debounceTimer) return;
  watcher.debounceTimer = setTimeout(() => {
    watcher.debounceTimer = undefined;
    requestMailboxProcessing(watcher.mailboxId, 0);
  }, delayMs);
}

function scheduleReconnect(watcher: IdleWatcher, reason: string) {
  if (watcher.stopped || watcher.reconnectTimer) return;
  const delayMs = Math.min(60000, 5000 * Math.max(1, watcher.reconnectAttempts + 1));
  watcher.reconnectAttempts += 1;
  updateMailboxSync(watcher.mailboxId, {
    lastError: `IMAP 实时监听中断，${Math.round(delayMs / 1000)} 秒后重连。${reason}`
  });
  watcher.reconnectTimer = setTimeout(() => {
    watcher.reconnectTimer = undefined;
    void connectWatcher(watcher);
  }, delayMs);
}

function reconnectClient(watcher: IdleWatcher, client: ImapFlow, reason: string) {
  if (watcher.stopped || watcher.client !== client) return;
  watcher.client = undefined;
  try {
    client.close();
  } catch {
    // The connection may already be closed.
  }
  scheduleReconnect(watcher, reason);
}

function maintainIdle(watcher: IdleWatcher, client: ImapFlow) {
  void (async () => {
    while (!watcher.stopped && watcher.client === client && client.usable) {
      try {
        await client.idle();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reconnectClient(watcher, client, `IDLE 中断：${message}`);
        return;
      }
    }
  })();
}

async function connectWatcher(watcher: IdleWatcher) {
  if (watcher.stopped || watcher.connecting || watcher.client?.usable) return;

  const mailbox = readMailboxes().find((item) => item.id === watcher.mailboxId);
  if (!mailbox || !mailbox.enabled || mailbox.protocol !== "imap") {
    await closeWatcher(watcher);
    watchers.delete(watcher.mailboxId);
    return;
  }

  watcher.connecting = true;
  try {
    const client = createImapClient(mailbox, {
      socketTimeout: 8 * 60 * 1000,
      maxIdleTime: 4 * 60 * 1000,
      missingIdleCommand: "NOOP"
    });
    watcher.client = client;

    client.on("exists", (event) => {
      if (watcher.client !== client) return;
      const count = Number(event.count || 0);
      const previous = Number(event.prevCount ?? watcher.lastExists ?? 0);
      watcher.lastExists = count;
      if (count > previous) {
        scheduleMailboxScan(watcher);
      }
    });

    client.on("error", (error) => {
      if (watcher.stopped || watcher.client !== client) return;
      updateMailboxSync(watcher.mailboxId, { lastError: `IMAP 实时监听错误：${error.message}` });
      reconnectClient(watcher, client, error.message);
    });

    client.on("close", () => {
      if (watcher.client !== client) return;
      watcher.client = undefined;
      scheduleReconnect(watcher, "连接已关闭。");
    });

    await client.connect();
    const previousExists = watcher.lastExists;
    const opened = await client.mailboxOpen(mailbox.folder || "INBOX");
    const unseen = (await client.search({ seen: false }, { uid: true })) || [];
    if (watcher.stopped || watcher.client !== client) {
      client.close();
      return;
    }
    watcher.lastExists = opened.exists;
    watcher.reconnectAttempts = 0;
    updateMailboxSync(watcher.mailboxId, {
      lastError: ""
    });

    // Catch unread messages that arrived before the first IDLE session or during reconnect.
    if (unseen.length > 0 || (previousExists !== undefined && opened.exists > previousExists)) {
      requestMailboxProcessing(watcher.mailboxId, 0);
    }
    maintainIdle(watcher, client);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (watcher.client) {
      const client = watcher.client;
      watcher.client = undefined;
      try {
        client.close();
      } catch {
        // Ignore close errors during failed connect.
      }
    }
    scheduleReconnect(watcher, message);
  } finally {
    watcher.connecting = false;
  }
}

function startWatcher(mailbox: Mailbox) {
  const watcher: IdleWatcher = {
    mailboxId: mailbox.id,
    fingerprint: mailboxFingerprint(mailbox),
    stopped: false,
    connecting: false,
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
  const settings = readSettings();
  const enabledImap = settings.system.autoProcessEnabled
    ? readMailboxes().filter((mailbox) => mailbox.enabled && mailbox.protocol === "imap")
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
      continue;
    }
    if (!existing.connecting && !existing.reconnectTimer && !existing.client?.usable) {
      scheduleReconnect(existing, "连接状态不可用。");
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
