import { useCallback, useEffect, useMemo, useState } from "react";
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
import { api } from "./api";
import type {
  AiSettings,
  Dashboard,
  EmailListItem,
  MailCategory,
  Mailbox,
  ProcessedEmail,
  SystemSettings
} from "./types";

type View = "mail" | "settings";

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

  const mailboxMap = useMemo(() => {
    const map = new Map<string, Mailbox>();
    dashboard?.mailboxes.forEach((mailbox) => map.set(mailbox.id, mailbox));
    return map;
  }, [dashboard]);

  const loadDashboard = useCallback(async () => {
    const next = await api.dashboard(selectedMailbox);
    setDashboard(next);
  }, [selectedMailbox]);

  const loadEmails = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.emails(activeCategory, selectedMailbox, query);
      setEmails(list);
      setSelectedEmailId((current) => {
        if (current && list.some((item) => item.id === current)) return current;
        return list[0]?.id ?? "";
      });
    } finally {
      setLoading(false);
    }
  }, [activeCategory, selectedMailbox, query]);

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
    const timer = window.setInterval(() => {
      void loadDashboard().catch(() => undefined);
    }, 15000);
    return () => window.clearInterval(timer);
  }, [loadDashboard]);

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
          <button className={view === "mail" ? "nav-item active" : "nav-item"} onClick={() => setView("mail")}>
            <SealCheck size={18} />
            处理台
          </button>
          <button
            className={view === "settings" ? "nav-item active" : "nav-item"}
            onClick={() => setView("settings")}
          >
            <GearSix size={18} />
            管理设置
          </button>
        </nav>

        <div className="mailbox-filter">
          <p className="section-kicker">邮箱视图</p>
          <button
            className={selectedMailbox === "all" ? "mailbox-chip active" : "mailbox-chip"}
            onClick={() => setSelectedMailbox("all")}
          >
            <MailboxIcon size={17} />
            <span>全部邮箱</span>
            <em>{dashboard?.total ?? 0}</em>
          </button>
          {dashboard?.mailboxes.map((mailbox) => (
            <button
              key={mailbox.id}
              className={selectedMailbox === mailbox.id ? "mailbox-chip active" : "mailbox-chip"}
              onClick={() => setSelectedMailbox(mailbox.id)}
            >
              <span className={mailbox.enabled ? "status-dot online" : "status-dot"} />
              <span>{mailbox.name}</span>
              <em>{mailbox.protocol.toUpperCase()}</em>
            </button>
          ))}
        </div>

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
            <p className="eyebrow">{activeMailboxName}</p>
            <h1>{view === "mail" ? "邮件处理台" : "管理设置"}</h1>
          </div>
          <div className="topbar-actions">
            <div className={dashboard?.processorRunning ? "run-state running" : "run-state"}>
              <span />
              {dashboard?.processorRunning ? "正在处理" : "空闲"}
            </div>
            <button className="primary-button" disabled={busy} onClick={runProcessing}>
              <Play size={18} weight="fill" />
              {busy ? "处理中" : "立即处理"}
            </button>
          </div>
        </header>

        {view === "mail" ? (
          <section className="mail-layout">
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
                  emails.map((email) => (
                    <button
                      key={email.id}
                      className={selectedEmailId === email.id ? "email-row active" : "email-row"}
                      onClick={() => setSelectedEmailId(email.id)}
                    >
                      <div className="email-row-top">
                        <strong>{email.subject}</strong>
                        <time>{formatTime(email.receivedAt || email.processedAt)}</time>
                      </div>
                      <div className="email-row-meta">
                        <span>{senderName(email)}</span>
                        <span>{mailboxMap.get(email.mailboxId)?.name || "邮箱"}</span>
                      </div>
                      <p>{email.summaryZh}</p>
                      <div className="email-row-bottom">
                        <span className="read-badge">
                          <CheckCircle size={15} />
                          {email.readMarked ? "已标记已读" : "已处理"}
                        </span>
                        {email.actionItemsZh.length > 0 && <em>{email.actionItemsZh.length} 个动作</em>}
                      </div>
                    </button>
                  ))
                ) : (
                  <div className="empty-state">
                    <ShieldCheck size={34} />
                    <h3>这里还没有邮件</h3>
                    <p>添加邮箱并运行处理后，系统会把所有已处理邮件自动归入这三个列表。</p>
                  </div>
                )}
              </div>
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

function EmailDetail({ detail, mailbox }: { detail: ProcessedEmail | null; mailbox?: Mailbox }) {
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

  const original = detail.rawSource || detail.originalText || "无可展示原文。";

  return (
    <aside className="detail-panel">
      <div className="detail-header">
        <span className={`category-pill ${detail.category}`}>{categoryMeta[detail.category].label}</span>
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
        <p className="section-kicker">邮件原件</p>
        <pre>{original}</pre>
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
              <button className="secondary-button full-span" disabled={saving} onClick={saveAi}>
                <FloppyDisk size={18} />
                保存 AI 设置
              </button>
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
