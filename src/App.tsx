import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import {
  Archive,
  CheckCircle,
  ClockCounterClockwise,
  EnvelopeSimple,
  FloppyDisk,
  GearSix,
  MagnifyingGlass,
  Mailbox as MailboxIcon,
  PencilSimple,
  Play,
  Plugs,
  Plus,
  SealCheck,
  ShieldCheck,
  Star,
  Trash,
  Warning,
  X
} from "@phosphor-icons/react";
import DOMPurify from "dompurify";
import { api } from "./api";
import type {
  AiSettings,
  Dashboard,
  EmailListItem,
  MailCategory,
  Mailbox,
  ProcessedEmail,
  ProcessingRun,
  SystemSettings
} from "./types";

type View = "mail" | "settings";
type EmailContextMenu = {
  x: number;
  y: number;
  emailId: string;
  panelRead: boolean;
};

const API_BASE =
  import.meta.env.VITE_API_BASE_URL ??
  (window.location.port === "5173" ? "http://127.0.0.1:8787" : "");

const categoryMeta: Record<
  MailCategory,
  { label: string; short: string; helper: string; icon: typeof Warning }
> = {
  important: {
    label: "重要",
    short: "需要处理",
    helper: "回复、付款、合同、安全、截止时间",
    icon: Warning
  },
  secondary: {
    label: "次重要",
    short: "稍后阅读",
    helper: "通知、资料、无需立刻行动的信息",
    icon: Star
  },
  ignore: {
    label: "不用管",
    short: "已归档",
    helper: "营销、订阅、社交提醒、低价值通知",
    icon: Archive
  }
};

function shouldAutoMarkPanelRead(category: MailCategory) {
  return category === "important" || category === "secondary";
}

const emptyMailbox: Partial<Mailbox> = {
  name: "",
  email: "",
  protocol: "imap",
  host: "",
  port: 993,
  secure: true,
  username: "",
  password: "",
  folder: "INBOX",
  enabled: true
};

function formatTime(value?: string) {
  if (!value) return "未知时间";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function senderName(email: EmailListItem | ProcessedEmail) {
  return email.fromName || email.fromAddress || "未知发件人";
}

const blockedEmailTags = [
  "script",
  "iframe",
  "object",
  "embed",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "option",
  "link",
  "base",
  "meta"
];

const resourceAttributes = new Set(["src", "srcset", "poster", "background", "action", "formaction", "ping"]);

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cleanInlineStyle(value: string) {
  return value
    .replace(/@import[^;]+;?/gi, "")
    .replace(/url\s*\([^)]*\)/gi, "")
    .replace(/expression\s*\([^)]*\)/gi, "")
    .replace(/behavior\s*:[^;]+;?/gi, "")
    .replace(/-moz-binding\s*:[^;]+;?/gi, "")
    .trim();
}

function emailApiPath(path: string) {
  return `${API_BASE}${path}`;
}

function proxiedRemoteImageUrl(value: string) {
  return emailApiPath(`/api/email-assets/image?url=${encodeURIComponent(value)}`);
}

function inlineImageUrl(emailId: string, cid: string) {
  return emailApiPath(`/api/emails/${encodeURIComponent(emailId)}/inline-image?cid=${encodeURIComponent(cid)}`);
}

function rewriteEmailImageSource(value: string, options: { emailId?: string; loadRemoteImages: boolean }) {
  if (/^data:image\/(?:png|jpe?g|gif|webp|avif);base64,/i.test(value)) return value;
  if (/^cid:/i.test(value) && options.emailId) return inlineImageUrl(options.emailId, value.replace(/^cid:/i, ""));
  if (options.loadRemoteImages && /^\/\//.test(value)) return proxiedRemoteImageUrl(`https:${value}`);
  if (options.loadRemoteImages && /^https?:\/\//i.test(value)) return proxiedRemoteImageUrl(value);
  return "";
}

function postProcessEmailHtml(html: string, options: { emailId?: string; loadRemoteImages: boolean }) {
  const template = document.createElement("template");
  template.innerHTML = html;

  template.content.querySelectorAll("*").forEach((node) => {
    const element = node as HTMLElement;

    Array.from(element.attributes).forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();

      if (name.startsWith("on")) {
        element.removeAttribute(attribute.name);
        return;
      }

      if (name === "href" || name.endsWith(":href")) {
        element.removeAttribute(attribute.name);
        return;
      }

      if (resourceAttributes.has(name)) {
        const nextSource =
          name === "src" && element.tagName.toLowerCase() === "img"
            ? rewriteEmailImageSource(value, options)
            : "";

        if (nextSource) {
          element.setAttribute(attribute.name, nextSource);
        } else {
          element.removeAttribute(attribute.name);
        }
        return;
      }

      if (name === "style") {
        const safeStyle = cleanInlineStyle(value);
        if (safeStyle) {
          element.setAttribute("style", safeStyle);
        } else {
          element.removeAttribute(attribute.name);
        }
      }
    });
  });

  return template.innerHTML;
}

function textToSafeHtml(text: string) {
  return `<pre class="plain-email">${escapeHtml(text || "无可展示原文。")}</pre>`;
}

function createSafeEmailSrcDoc(sourceHtml: string, options: { emailId?: string; loadRemoteImages: boolean }) {
  const sanitized = DOMPurify.sanitize(sourceHtml, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: blockedEmailTags,
    FORBID_ATTR: ["autofocus", "srcdoc"],
    ALLOW_DATA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: true
  });
  const body = postProcessEmailHtml(sanitized, options);

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src data: blob: http: https:; style-src 'unsafe-inline'; font-src data:; media-src data: blob:; frame-src 'none'; connect-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none';"
    />
    <style>
      :root {
        color-scheme: light;
        font-family: Aptos, "Segoe UI", system-ui, sans-serif;
        color: #151a19;
        background: #ffffff;
      }
      * {
        box-sizing: border-box;
      }
      html,
      body {
        margin: 0;
        min-height: 100%;
        background: #ffffff;
      }
      body {
        padding: 18px;
      }
      img {
        max-width: 100%;
        height: auto;
      }
      table {
        max-width: 100%;
        border-collapse: collapse;
      }
      a {
        color: inherit;
        text-decoration: underline;
        text-decoration-style: dotted;
      }
      .plain-email {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        font: 13px/1.65 "Cascadia Mono", "SFMono-Regular", Consolas, monospace;
      }
    </style>
  </head>
  <body>${body || textToSafeHtml("无可展示原文。")}</body>
</html>`;
}

function App() {
  const [view, setView] = useState<View>("mail");
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [activeCategory, setActiveCategory] = useState<MailCategory>("important");
  const [selectedMailbox, setSelectedMailbox] = useState("all");
  const [emails, setEmails] = useState<EmailListItem[]>([]);
  const [selectedEmailId, setSelectedEmailId] = useState<string>("");
  const [detail, setDetail] = useState<ProcessedEmail | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [detailWidth, setDetailWidth] = useState(560);
  const [contextMenu, setContextMenu] = useState<EmailContextMenu | null>(null);
  const [autoReadSuppressedId, setAutoReadSuppressedId] = useState<string | null>(null);
  const mailLayoutRef = useRef<HTMLElement | null>(null);

  const clampDetailWidth = useCallback((nextWidth: number) => {
    const layoutWidth = mailLayoutRef.current?.getBoundingClientRect().width;
    const minDetailWidth = 500;
    const maxDetailWidth = layoutWidth
      ? Math.max(minDetailWidth, Math.min(920, layoutWidth - 520))
      : 920;

    return Math.round(Math.min(Math.max(nextWidth, minDetailWidth), maxDetailWidth));
  }, []);

  const startDetailResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      document.body.classList.add("resizing-detail");

      const move = (moveEvent: PointerEvent) => {
        const bounds = mailLayoutRef.current?.getBoundingClientRect();
        if (!bounds) return;
        setDetailWidth(clampDetailWidth(bounds.right - moveEvent.clientX));
      };

      const stop = () => {
        document.body.classList.remove("resizing-detail");
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stop);
        window.removeEventListener("pointercancel", stop);
      };

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop);
      window.addEventListener("pointercancel", stop);
    },
    [clampDetailWidth]
  );

  const nudgeDetailWidth = useCallback(
    (delta: number) => {
      setDetailWidth((current) => clampDetailWidth(current + delta));
    },
    [clampDetailWidth]
  );

  const mailLayoutStyle = useMemo(
    () => ({ "--detail-width": `${detailWidth}px` }) as CSSProperties,
    [detailWidth]
  );

  const mailboxMap = useMemo(() => {
    const map = new Map<string, Mailbox>();
    dashboard?.mailboxes.forEach((mailbox) => map.set(mailbox.id, mailbox));
    return map;
  }, [dashboard]);

  const loadDashboard = useCallback(async () => {
    const next = await api.dashboard(selectedMailbox);
    setDashboard(next);
  }, [selectedMailbox]);

  const loadEmails = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const list = await api.emails(activeCategory, selectedMailbox, query);
      setEmails(list);
      setSelectedEmailId((current) => {
        if (current && list.some((item) => item.id === current)) return current;
        return list[0]?.id ?? "";
      });
    } finally {
      if (!silent) setLoading(false);
    }
  }, [activeCategory, selectedMailbox, query]);

  const applyEmailReadState = useCallback((updated: ProcessedEmail) => {
    setEmails((current) =>
      current.map((email) =>
        email.id === updated.id
          ? { ...email, panelRead: updated.panelRead, panelReadAt: updated.panelReadAt }
          : email
      )
    );
    setDetail((current) =>
      current?.id === updated.id
        ? { ...current, panelRead: updated.panelRead, panelReadAt: updated.panelReadAt }
        : current
    );
  }, []);

  const updateEmailReadState = useCallback(
    async (id: string, panelRead: boolean, options: { silent?: boolean; suppressAutoRead?: boolean } = {}) => {
      const updated = await api.updateEmailReadState(id, panelRead);
      applyEmailReadState(updated);
      if (!panelRead && options.suppressAutoRead) {
        setAutoReadSuppressedId(id);
      }
      if (panelRead) {
        setAutoReadSuppressedId((current) => (current === id ? null : current));
      }
      if (!options.silent) {
        setToast(panelRead ? "已标记为系统已读" : "已标记为系统未读");
      }
    },
    [applyEmailReadState]
  );

  const openEmailContextMenu = useCallback((event: ReactMouseEvent<HTMLButtonElement>, email: EmailListItem) => {
    event.preventDefault();
    setSelectedEmailId(email.id);
    setContextMenu({
      x: Math.min(event.clientX, window.innerWidth - 210),
      y: Math.min(event.clientY, window.innerHeight - 86),
      emailId: email.id,
      panelRead: email.panelRead
    });
  }, []);

  useEffect(() => {
    void loadDashboard().catch((error) => setToast(error.message));
  }, [loadDashboard]);

  useEffect(() => {
    if (view === "mail") {
      void loadEmails().catch((error) => setToast(error.message));
    }
  }, [view, loadEmails]);

  useEffect(() => {
    if (!selectedEmailId) {
      setDetail(null);
      return;
    }

    void api
      .email(selectedEmailId)
      .then(setDetail)
      .catch((error) => setToast(error.message));
  }, [selectedEmailId]);

  useEffect(() => {
    setAutoReadSuppressedId(null);
  }, [selectedEmailId]);

  useEffect(() => {
    if (!detail || detail.panelRead || !shouldAutoMarkPanelRead(detail.category)) return;
    if (detail.id === autoReadSuppressedId) return;

    const timer = window.setTimeout(() => {
      void updateEmailReadState(detail.id, true, { silent: true }).catch((error) => setToast(error.message));
    }, 2000);

    return () => window.clearTimeout(timer);
  }, [autoReadSuppressedId, detail?.id, detail?.panelRead, detail?.category, updateEmailReadState]);

  useEffect(() => {
    if (!contextMenu) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setContextMenu(null);
    };

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [contextMenu]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadDashboard().catch(() => undefined);
    }, 15000);
    return () => window.clearInterval(timer);
  }, [loadDashboard]);

  useEffect(() => {
    if (!dashboard?.processorRunning) return;
    const timer = window.setInterval(() => {
      void loadDashboard().catch(() => undefined);
      if (view === "mail") {
        void loadEmails(true).catch(() => undefined);
      }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [dashboard?.processorRunning, loadDashboard, loadEmails, view]);

  async function runProcessing() {
    setBusy(true);
    setToast("");
    try {
      const run = await api.run(selectedMailbox);
      await loadDashboard();
      await loadEmails();
      setToast(`处理完成：${run.processedCount} 封邮件，重要 ${run.importantCount} 封。`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const activeMailboxName =
    selectedMailbox === "all" ? "全部邮箱" : mailboxMap.get(selectedMailbox)?.name || "当前邮箱";
  const pageEyebrow = view === "mail" ? activeMailboxName : "系统配置";
  const runStatusText = dashboard?.processorRunning
    ? dashboard.currentRun?.currentStage || "正在处理"
    : "空闲";

  return (
    <div className="app-shell">
      <aside className="side-panel" aria-label="主导航">
        <div className="brand-lockup">
          <div className="brand-mark">
            <EnvelopeSimple size={22} weight="duotone" />
          </div>
          <div>
            <strong>自动邮件系统</strong>
            <span>AI Inbox Console</span>
          </div>
        </div>

        <nav className="nav-stack">
          <div className={view === "mail" ? "nav-group active" : "nav-group"}>
            <button className={view === "mail" ? "nav-item active" : "nav-item"} onClick={() => setView("mail")}>
              <SealCheck size={18} />
              处理台
            </button>
            {view === "mail" && (
              <div className="mailbox-submenu" aria-label="处理台邮箱视图">
                <p className="submenu-label">邮箱视图</p>
                <button
                  className={selectedMailbox === "all" ? "mailbox-chip active" : "mailbox-chip"}
                  onClick={() => setSelectedMailbox("all")}
                  title="全部邮箱"
                >
                  <MailboxIcon size={17} />
                  <span className="mailbox-chip-label">全部邮箱</span>
                  <em>{dashboard?.allTotal ?? dashboard?.total ?? 0}</em>
                </button>
                {dashboard?.mailboxes.map((mailbox) => (
                  <button
                    key={mailbox.id}
                    className={selectedMailbox === mailbox.id ? "mailbox-chip active" : "mailbox-chip"}
                    onClick={() => setSelectedMailbox(mailbox.id)}
                    title={`${mailbox.name} · ${mailbox.email}`}
                  >
                    <span className={mailbox.enabled ? "status-dot online" : "status-dot"} />
                    <span className="mailbox-chip-label">{mailbox.name}</span>
                    <em>{mailbox.protocol.toUpperCase()}</em>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            className={view === "settings" ? "nav-item active" : "nav-item"}
            onClick={() => setView("settings")}
          >
            <GearSix size={18} />
            管理设置
          </button>
        </nav>

        <div className="side-footer">
          <ClockCounterClockwise size={17} />
          <span>
            {dashboard?.settings.system.autoProcessEnabled
              ? `${dashboard.settings.system.pollIntervalMinutes} 分钟自动处理`
              : "自动处理已关闭"}
          </span>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">{pageEyebrow}</p>
            <h1>{view === "mail" ? "邮件处理台" : "管理设置"}</h1>
          </div>
          <div className="topbar-actions">
            <div className={dashboard?.processorRunning ? "run-state running" : "run-state"}>
              <span />
              {runStatusText}
            </div>
            <button className="primary-button" disabled={busy} onClick={runProcessing}>
              <Play size={18} weight="fill" />
              {busy ? "处理中" : "立即处理"}
            </button>
          </div>
        </header>

        {view === "mail" ? (
          <section ref={mailLayoutRef} className="mail-layout" style={mailLayoutStyle}>
            <div className="mail-main">
              <div className="metric-grid">
                {(Object.keys(categoryMeta) as MailCategory[]).map((category) => {
                  const Icon = categoryMeta[category].icon;
                  const active = activeCategory === category;
                  return (
                    <button
                      key={category}
                      className={active ? `metric-card ${category} active` : `metric-card ${category}`}
                      onClick={() => setActiveCategory(category)}
                    >
                      <div className="metric-icon">
                        <Icon size={22} />
                      </div>
                      <span>{categoryMeta[category].label}</span>
                      <strong>{dashboard?.counts[category] ?? 0}</strong>
                      <small>{categoryMeta[category].short}</small>
                    </button>
                  );
                })}
              </div>

              <ProcessingProgress run={dashboard?.currentRun} running={Boolean(dashboard?.processorRunning)} />

              <div className="list-toolbar">
                <div>
                  <h2>{categoryMeta[activeCategory].label}邮件</h2>
                  <p>{categoryMeta[activeCategory].helper}</p>
                </div>
                <label className="search-box">
                  <MagnifyingGlass size={18} />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="搜索主题、发件人、中文概况"
                  />
                </label>
              </div>

              <div className="email-list">
                {loading ? (
                  Array.from({ length: 5 }).map((_, index) => <div className="email-skeleton" key={index} />)
                ) : emails.length ? (
                  emails.map((email) => {
                    const rowClassName = [
                      "email-row",
                      selectedEmailId === email.id ? "active" : "",
                      email.panelRead ? "panel-read" : "panel-unread"
                    ]
                      .filter(Boolean)
                      .join(" ");

                    return (
                      <button
                        key={email.id}
                        className={rowClassName}
                        onClick={() => setSelectedEmailId(email.id)}
                        onContextMenu={(event) => openEmailContextMenu(event, email)}
                      >
                        <div className="email-row-top">
                          <div className="email-row-title">
                            <span className={email.panelRead ? "read-dot" : "read-dot unread"} />
                            <strong>{email.subject}</strong>
                          </div>
                          <time>{formatTime(email.receivedAt || email.processedAt)}</time>
                        </div>
                        <div className="email-row-meta">
                          <span>{senderName(email)}</span>
                          <span>{mailboxMap.get(email.mailboxId)?.name || "邮箱"}</span>
                        </div>
                        <p>{email.summaryZh}</p>
                        <div className="email-row-bottom">
                          <div className="email-row-statuses">
                            <span className={email.panelRead ? "panel-state read" : "panel-state unread"}>
                              {email.panelRead ? <CheckCircle size={15} /> : <EnvelopeSimple size={15} />}
                              {email.panelRead ? "系统已读" : "系统未读"}
                            </span>
                            <span className="read-badge">
                              <CheckCircle size={15} />
                              {email.readMarked ? "邮箱已读" : "邮箱待确认"}
                            </span>
                          </div>
                          {email.actionItemsZh.length > 0 && <em>{email.actionItemsZh.length} 个动作</em>}
                        </div>
                      </button>
                    );
                  })
                ) : (
                  <div className="empty-state">
                    <ShieldCheck size={34} />
                    <h3>这里还没有邮件</h3>
                    <p>添加邮箱并运行处理后，系统会把所有已处理邮件自动归入这三个列表。</p>
                  </div>
                )}
              </div>
            </div>

            <div
              className="mail-resizer"
              role="separator"
              aria-label="调整邮件预览宽度"
              aria-orientation="vertical"
              tabIndex={0}
              onPointerDown={startDetailResize}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft") {
                  event.preventDefault();
                  nudgeDetailWidth(32);
                }
                if (event.key === "ArrowRight") {
                  event.preventDefault();
                  nudgeDetailWidth(-32);
                }
              }}
            >
              <span />
            </div>

            <EmailDetail detail={detail} mailbox={detail ? mailboxMap.get(detail.mailboxId) : undefined} />
          </section>
        ) : (
          <SettingsPanel
            dashboard={dashboard}
            onReload={async () => {
              await loadDashboard();
              await loadEmails();
            }}
            setToast={setToast}
          />
        )}
      </main>

      {contextMenu && (
        <>
          <div
            className="context-menu-shield"
            onClick={() => setContextMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setContextMenu(null);
            }}
          />
          <div
            className="email-context-menu"
            role="menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const nextReadState = !contextMenu.panelRead;
                const emailId = contextMenu.emailId;
                setContextMenu(null);
                void updateEmailReadState(emailId, nextReadState, { suppressAutoRead: !nextReadState }).catch((error) =>
                  setToast(error.message)
                );
              }}
            >
              {contextMenu.panelRead ? <EnvelopeSimple size={16} /> : <CheckCircle size={16} />}
              {contextMenu.panelRead ? "标记为系统未读" : "标记为系统已读"}
            </button>
          </div>
        </>
      )}

      {toast && (
        <div className="toast" role="status">
          <span>{toast}</span>
          <button onClick={() => setToast("")} aria-label="关闭提示">
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

function progressPercent(done = 0, total = 0) {
  if (!total || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

function getRunProgress(run?: ProcessingRun | null) {
  const totalUnread = run?.totalUnreadCount ?? 0;
  const handledUnread = run?.handledUnreadCount ?? 0;
  const total = run?.totalTaskCount ?? totalUnread;
  const handled = run?.handledTaskCount ?? Math.max(run?.processedCount ?? 0, handledUnread);

  return {
    total,
    handled,
    percent: progressPercent(handled, total)
  };
}

function ProcessingProgress({ run, running }: { run?: ProcessingRun | null; running: boolean }) {
  const totalUnread = run?.totalUnreadCount ?? 0;
  const handledUnread = run?.handledUnreadCount ?? 0;
  const runProgress = getRunProgress(run);
  const mailboxTotal = run?.currentMailboxUnreadCount ?? 0;
  const mailboxHandled = run?.currentMailboxHandledCount ?? 0;
  const mailboxPercent = progressPercent(mailboxHandled, mailboxTotal);
  const emailStepTotal = run?.currentEmailStepTotal ?? 0;
  const emailStepIndex = run?.currentEmailStepIndex ?? 0;
  const visibleStepTotal = emailStepTotal || 4;
  const mailboxLabel =
    run?.currentMailboxName && run.totalMailboxCount
      ? `${run.currentMailboxName} · ${run.currentMailboxIndex ?? 1}/${run.totalMailboxCount}`
      : run?.currentMailboxName || "等待任务";
  const currentEmailLabel = run?.currentEmailStep || run?.currentStage || "等待下一封邮件";

  return (
    <section className={running ? "progress-panel active" : "progress-panel"} aria-label="邮件处理进度">
      <div className="progress-heading">
        <div>
          <p className="section-kicker">处理进度</p>
          <h2>{running ? "正在处理邮件" : "当前没有运行中的任务"}</h2>
        </div>
        <span className={running ? "progress-status running" : "progress-status"}>
          <i />
          {running ? "运行中" : "空闲"}
        </span>
      </div>

      <div className="progress-grid">
        <div className="progress-card">
          <div className="progress-row">
            <span>本轮任务</span>
            <strong>{runProgress.handled}/{runProgress.total}</strong>
          </div>
          <div className="progress-track" aria-label={`本轮进度 ${runProgress.percent}%`}>
            <span style={{ width: `${runProgress.percent}%` }} />
          </div>
          <p>未读 {handledUnread}/{totalUnread}</p>
        </div>

        <div className="progress-card">
          <div className="progress-row">
            <span>{mailboxLabel}</span>
            <strong>{mailboxHandled}/{mailboxTotal}</strong>
          </div>
          <div className="progress-track" aria-label={`当前邮箱进度 ${mailboxPercent}%`}>
            <span style={{ width: `${mailboxPercent}%` }} />
          </div>
        </div>

        <div className="progress-card current-email-card">
          <div className="progress-row">
            <span>当前邮件</span>
            <strong>{emailStepTotal ? `${emailStepIndex}/${emailStepTotal}` : "--"}</strong>
          </div>
          <div className="step-strip" aria-label={`当前邮件步骤 ${emailStepIndex}/${visibleStepTotal}`}>
            {Array.from({ length: visibleStepTotal }).map((_, index) => {
              const step = index + 1;
              const className =
                step < emailStepIndex ? "step-dot done" : step === emailStepIndex ? "step-dot active" : "step-dot";
              return <span className={className} key={step} />;
            })}
          </div>
          <p>
            <strong>{currentEmailLabel}</strong>
            {run?.currentSubject ? ` · ${run.currentSubject}` : ""}
          </p>
        </div>
      </div>
    </section>
  );
}

function EmailDetail({ detail, mailbox }: { detail: ProcessedEmail | null; mailbox?: Mailbox }) {
  const [originalMode, setOriginalMode] = useState<"rendered" | "source">("rendered");
  const [loadImages, setLoadImages] = useState(false);

  useEffect(() => {
    setOriginalMode("rendered");
    setLoadImages(false);
  }, [detail?.id]);

  const originalSource = useMemo(() => {
    if (!detail) return "无可展示原文。";
    return detail.rawSource || detail.originalHtml || detail.originalText || "无可展示原文。";
  }, [detail]);

  const originalPreview = useMemo(() => {
    if (!detail) return "";
    const sourceHtml = detail.originalHtml?.trim()
      ? detail.originalHtml
      : textToSafeHtml(detail.originalText || originalSource);

    return createSafeEmailSrcDoc(sourceHtml, {
      emailId: detail.id,
      loadRemoteImages: loadImages
    });
  }, [detail, originalSource, loadImages]);

  if (!detail) {
    return (
      <aside className="detail-panel empty">
        <div>
          <EnvelopeSimple size={38} />
          <h2>选择一封邮件</h2>
          <p>这里会显示中文概况、处理理由、动作项和邮件原件。</p>
        </div>
      </aside>
    );
  }

  return (
    <aside className="detail-panel">
      <div className="detail-header">
        <div className="detail-pills">
          <span className={`category-pill ${detail.category}`}>{categoryMeta[detail.category].label}</span>
          <span className={detail.panelRead ? "panel-state read" : "panel-state unread"}>
            {detail.panelRead ? <CheckCircle size={15} /> : <EnvelopeSimple size={15} />}
            {detail.panelRead ? "系统已读" : "系统未读"}
          </span>
        </div>
        <time>{formatTime(detail.receivedAt || detail.processedAt)}</time>
      </div>
      <h2>{detail.subject}</h2>
      <div className="detail-meta">
        <span>发件人：{senderName(detail)}</span>
        <span>邮箱：{mailbox?.name || "未知邮箱"}</span>
        {detail.toText && <span>收件人：{detail.toText}</span>}
      </div>

      <section className="summary-block">
        <p className="section-kicker">中文概况</p>
        <p>{detail.summaryZh}</p>
      </section>

      <section className="summary-block">
        <p className="section-kicker">判断理由</p>
        <p>{detail.reasonZh}</p>
      </section>

      {detail.actionItemsZh.length > 0 && (
        <section className="summary-block">
          <p className="section-kicker">建议动作</p>
          <ul className="action-list">
            {detail.actionItemsZh.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="original-block">
        <div className="original-heading">
          <div>
            <p className="section-kicker">邮件原件</p>
            <span className="security-note">
              <ShieldCheck size={14} />
              {loadImages
                ? "安全沙箱预览，图片通过本地代理加载，脚本、表单和插件仍禁用"
                : "安全沙箱预览，已禁用脚本、表单、插件和远程图片"}
            </span>
          </div>
          <div className="original-actions">
            <button
              className={loadImages ? "image-load-button active" : "image-load-button"}
              type="button"
              onClick={() => setLoadImages((current) => !current)}
            >
              {loadImages ? "隐藏图片" : "加载图片"}
            </button>
            <div className="view-toggle" role="tablist" aria-label="邮件原件视图">
              <button
                className={originalMode === "rendered" ? "active" : ""}
                type="button"
                onClick={() => setOriginalMode("rendered")}
              >
                渲染
              </button>
              <button
                className={originalMode === "source" ? "active" : ""}
                type="button"
                onClick={() => setOriginalMode("source")}
              >
                源码
              </button>
            </div>
          </div>
        </div>
        {originalMode === "rendered" ? (
          <iframe
            className="email-html-frame"
            title="邮件原件安全预览"
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={originalPreview}
          />
        ) : (
          <pre className="raw-source">{originalSource}</pre>
        )}
      </section>
    </aside>
  );
}

function SettingsPanel({
  dashboard,
  onReload,
  setToast
}: {
  dashboard: Dashboard | null;
  onReload: () => Promise<void>;
  setToast: (message: string) => void;
}) {
  const [aiForm, setAiForm] = useState<AiSettings | null>(null);
  const [systemForm, setSystemForm] = useState<SystemSettings | null>(null);
  const [mailboxForm, setMailboxForm] = useState<Partial<Mailbox>>(emptyMailbox);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!dashboard) return;
    setAiForm({ ...dashboard.settings.ai, apiKey: "" });
    setSystemForm(dashboard.settings.system);
  }, [dashboard]);

  async function saveAi() {
    if (!aiForm) return;
    setSaving(true);
    try {
      await api.updateAi(aiForm);
      await onReload();
      setToast("AI 设置已保存。");
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function testAi() {
    if (!aiForm) return;
    setSaving(true);
    try {
      const result = await api.testAi(aiForm);
      setToast(result.message);
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function saveSystem() {
    if (!systemForm) return;
    setSaving(true);
    try {
      await api.updateSystem(systemForm);
      await onReload();
      setToast("系统设置已保存。");
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function saveMailbox() {
    setSaving(true);
    try {
      await api.saveMailbox(mailboxForm);
      setMailboxForm(emptyMailbox);
      await onReload();
      setToast("邮箱已保存。");
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function deleteMailbox(id: string) {
    setSaving(true);
    try {
      await api.deleteMailbox(id);
      await onReload();
      setToast("邮箱已删除。");
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function testMailbox(id: string) {
    setSaving(true);
    try {
      const result = await api.testMailbox(id);
      setToast(result.message);
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="settings-layout">
      <div className="settings-column">
        <div className="settings-panel">
          <div className="panel-heading">
            <div>
              <p className="section-kicker">AI API</p>
              <h2>智谱 GLM Coding Plan</h2>
            </div>
            <Plugs size={22} />
          </div>
          {aiForm && (
            <div className="form-grid">
              <label>
                服务名称
                <input
                  value={aiForm.providerName}
                  onChange={(event) => setAiForm({ ...aiForm, providerName: event.target.value })}
                />
              </label>
              <label>
                Base URL
                <input
                  value={aiForm.baseUrl}
                  onChange={(event) => setAiForm({ ...aiForm, baseUrl: event.target.value })}
                />
              </label>
              <label>
                模型
                <input value={aiForm.model} onChange={(event) => setAiForm({ ...aiForm, model: event.target.value })} />
              </label>
              <label>
                Temperature
                <input
                  type="number"
                  min="0"
                  max="2"
                  step="0.1"
                  value={aiForm.temperature}
                  onChange={(event) => setAiForm({ ...aiForm, temperature: Number(event.target.value) })}
                />
              </label>
              <label className="full-span">
                API Key
                <input
                  type="password"
                  value={aiForm.apiKey}
                  placeholder={aiForm.hasApiKey ? `已保存 ${aiForm.maskedApiKey}，留空不修改` : "输入 API Key"}
                  onChange={(event) => setAiForm({ ...aiForm, apiKey: event.target.value })}
                />
              </label>
              <div className="form-actions full-span">
                <button className="ghost-button" disabled={saving} onClick={testAi}>
                  <Plugs size={18} />
                  测试 AI API
                </button>
                <button className="secondary-button" disabled={saving} onClick={saveAi}>
                  <FloppyDisk size={18} />
                  保存 AI 设置
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="settings-panel">
          <div className="panel-heading">
            <div>
              <p className="section-kicker">自动处理</p>
              <h2>轮询策略</h2>
            </div>
            <ClockCounterClockwise size={22} />
          </div>
          {systemForm && (
            <div className="form-grid">
              <label className="switch-row full-span">
                <span>
                  <strong>开启自动处理</strong>
                  <small>服务启动后定时读取未读邮件</small>
                </span>
                <input
                  type="checkbox"
                  checked={systemForm.autoProcessEnabled}
                  onChange={(event) => setSystemForm({ ...systemForm, autoProcessEnabled: event.target.checked })}
                />
              </label>
              <label>
                轮询间隔，分钟
                <input
                  type="number"
                  min="1"
                  value={systemForm.pollIntervalMinutes}
                  onChange={(event) =>
                    setSystemForm({ ...systemForm, pollIntervalMinutes: Number(event.target.value) })
                  }
                />
              </label>
              <label>
                每个邮箱单次上限
                <input
                  type="number"
                  min="1"
                  value={systemForm.processLimitPerMailbox}
                  onChange={(event) =>
                    setSystemForm({ ...systemForm, processLimitPerMailbox: Number(event.target.value) })
                  }
                />
              </label>
              <button className="secondary-button full-span" disabled={saving} onClick={saveSystem}>
                <FloppyDisk size={18} />
                保存系统设置
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="settings-column wide">
        <div className="settings-panel">
          <div className="panel-heading">
            <div>
              <p className="section-kicker">多邮箱</p>
              <h2>{mailboxForm.id ? "编辑邮箱" : "添加邮箱"}</h2>
            </div>
            <Plus size={22} />
          </div>
          <div className="form-grid mailbox-form">
            <label>
              名称
              <input
                value={mailboxForm.name || ""}
                onChange={(event) => setMailboxForm({ ...mailboxForm, name: event.target.value })}
              />
            </label>
            <label>
              邮箱地址
              <input
                value={mailboxForm.email || ""}
                onChange={(event) => setMailboxForm({ ...mailboxForm, email: event.target.value })}
              />
            </label>
            <label>
              协议
              <select
                value={mailboxForm.protocol || "imap"}
                onChange={(event) => {
                  const protocol = event.target.value as "imap" | "pop3";
                  setMailboxForm({
                    ...mailboxForm,
                    protocol,
                    port: protocol === "imap" ? 993 : 995,
                    folder: protocol === "imap" ? mailboxForm.folder || "INBOX" : ""
                  });
                }}
              >
                <option value="imap">IMAP</option>
                <option value="pop3">POP3</option>
              </select>
            </label>
            <label>
              主机
              <input
                placeholder="imap.example.com"
                value={mailboxForm.host || ""}
                onChange={(event) => setMailboxForm({ ...mailboxForm, host: event.target.value })}
              />
            </label>
            <label>
              端口
              <input
                type="number"
                value={mailboxForm.port || ""}
                onChange={(event) => setMailboxForm({ ...mailboxForm, port: Number(event.target.value) })}
              />
            </label>
            <label>
              文件夹
              <input
                disabled={mailboxForm.protocol === "pop3"}
                value={mailboxForm.folder || ""}
                onChange={(event) => setMailboxForm({ ...mailboxForm, folder: event.target.value })}
              />
            </label>
            <label>
              用户名
              <input
                value={mailboxForm.username || ""}
                onChange={(event) => setMailboxForm({ ...mailboxForm, username: event.target.value })}
              />
            </label>
            <label>
              密码或授权码
              <input
                type="password"
                value={mailboxForm.password || ""}
                placeholder={mailboxForm.hasPassword ? "已保存，留空不修改" : "输入密码或授权码"}
                onChange={(event) => setMailboxForm({ ...mailboxForm, password: event.target.value })}
              />
            </label>
            <label className="switch-row">
              <span>
                <strong>SSL/TLS</strong>
                <small>推荐开启</small>
              </span>
              <input
                type="checkbox"
                checked={Boolean(mailboxForm.secure)}
                onChange={(event) => setMailboxForm({ ...mailboxForm, secure: event.target.checked })}
              />
            </label>
            <label className="switch-row">
              <span>
                <strong>启用</strong>
                <small>自动处理此邮箱</small>
              </span>
              <input
                type="checkbox"
                checked={Boolean(mailboxForm.enabled)}
                onChange={(event) => setMailboxForm({ ...mailboxForm, enabled: event.target.checked })}
              />
            </label>
            <div className="form-actions full-span">
              <button className="secondary-button" disabled={saving} onClick={saveMailbox}>
                <FloppyDisk size={18} />
                保存邮箱
              </button>
              {mailboxForm.id && (
                <button className="ghost-button" onClick={() => setMailboxForm(emptyMailbox)}>
                  <X size={18} />
                  取消编辑
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="mailbox-table">
          {dashboard?.mailboxes.length ? (
            dashboard.mailboxes.map((mailbox) => (
              <div className="mailbox-row" key={mailbox.id}>
                <div>
                  <strong>{mailbox.name}</strong>
                  <span>{mailbox.email}</span>
                  {mailbox.lastError && <small className="error-text">{mailbox.lastError}</small>}
                </div>
                <div className="mailbox-row-meta">
                  <span>{mailbox.protocol.toUpperCase()}</span>
                  <span>{mailbox.lastSyncAt ? formatTime(mailbox.lastSyncAt) : "未同步"}</span>
                </div>
                <div className="row-actions">
                  <button onClick={() => testMailbox(mailbox.id)} title="测试连接">
                    <Plugs size={17} />
                  </button>
                  <button
                    onClick={() =>
                      setMailboxForm({
                        ...mailbox,
                        password: ""
                      })
                    }
                    title="编辑"
                  >
                    <PencilSimple size={17} />
                  </button>
                  <button onClick={() => deleteMailbox(mailbox.id)} title="删除">
                    <Trash size={17} />
                  </button>
                </div>
              </div>
            ))
          ) : (
            <div className="empty-state compact">
              <MailboxIcon size={30} />
              <h3>还没有邮箱</h3>
              <p>添加 IMAP 或 POP3 邮箱后，系统就能开始读取并分类邮件。</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export default App;
