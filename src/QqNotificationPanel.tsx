import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Archive,
  BellRinging,
  CaretDown,
  CheckCircle,
  FloppyDisk,
  LinkSimple,
  LockSimple,
  PaperPlaneTilt,
  Plugs,
  Pulse,
  Robot,
  SealCheck,
  ShieldCheck,
  Star,
  Warning
} from "@phosphor-icons/react";
import { api } from "./api";
import "./qq-notification.css";
import type {
  MailCategory,
  QqAgentPermission,
  QqAgentRun,
  QqAgentSettings,
  PublicQqBotSettings,
  QqBindingChallenge,
  QqBotPublicStatus
} from "./types";

type QqForm = {
  appId: string;
  appSecret: string;
  enabled: boolean;
  quoteImageMarksRead: boolean;
  agent: QqAgentSettings;
  notifyCategories: Record<MailCategory, boolean>;
};

const defaultAgentPermissions: Record<QqAgentPermission, boolean> = {
  readMail: true,
  sendMailImages: true,
  readAttachments: true,
  sendAttachments: true,
  manageReadState: true,
  manageNotifications: true,
  runProcessing: true,
  checkMailboxes: true,
  reclassifyMail: true
};

const defaultAgentSettings: QqAgentSettings = {
  enabled: false,
  requireConfirmation: true,
  maxResults: 6,
  permissions: defaultAgentPermissions
};

const categories: Array<{
  id: MailCategory;
  label: string;
  icon: typeof Warning;
}> = [
  { id: "important", label: "重要", icon: Warning },
  { id: "secondary", label: "次重要", icon: Star },
  { id: "ignore", label: "不用管", icon: Archive }
];

const agentPermissions: Array<{
  id: QqAgentPermission;
  label: string;
  detail: string;
}> = [
  { id: "readMail", label: "查看/搜索邮件", detail: "最近邮件、分类列表、详情、统计" },
  { id: "sendMailImages", label: "发送邮件图片", detail: "生成邮件卡片并通过 QQ 富媒体发送" },
  { id: "readAttachments", label: "读取/概括附件", detail: "列出附件，读取文本，隔离分析图片和 PDF" },
  { id: "sendAttachments", label: "发送原附件", detail: "通过 QQ 文件富媒体发送安全附件，单个不超过 4 MB" },
  { id: "manageReadState", label: "修改已读状态", detail: "单封、分类、邮箱批量标记已读" },
  { id: "manageNotifications", label: "管理通知队列", detail: "查看失败、重试、暂停、恢复" },
  { id: "runProcessing", label: "手动处理邮箱", detail: "处理全部、指定邮箱、同步新邮件" },
  { id: "checkMailboxes", label: "检查邮箱", detail: "查看邮箱列表和连接健康" },
  { id: "reclassifyMail", label: "调整分类", detail: "重新 AI 分类或手动移动分类" }
];

function normalizeAgent(settings: PublicQqBotSettings): QqAgentSettings {
  const agent = settings.agent ?? defaultAgentSettings;
  return {
    enabled: agent.enabled ?? false,
    requireConfirmation: agent.requireConfirmation ?? true,
    maxResults: Math.min(10, Math.max(3, Math.floor(agent.maxResults ?? 6))),
    permissions: {
      ...defaultAgentPermissions,
      ...(agent.permissions ?? {})
    }
  };
}

function formFromSettings(settings: PublicQqBotSettings): QqForm {
  return {
    appId: settings.appId,
    appSecret: "",
    enabled: settings.enabled,
    quoteImageMarksRead: settings.quoteImageMarksRead ?? true,
    agent: normalizeAgent(settings),
    notifyCategories: {
      important: settings.notifyCategories?.important ?? true,
      secondary: settings.notifyCategories?.secondary ?? true,
      ignore: settings.notifyCategories?.ignore ?? false
    }
  };
}

function gatewayLabel(status: QqBotPublicStatus | null) {
  const state = status?.gateway.state ?? "stopped";
  return {
    stopped: "未连接",
    connecting: "正在连接",
    identifying: "正在鉴权",
    resuming: "正在恢复",
    online: "实时在线",
    reconnecting: "正在重连",
    blocked: "连接受阻"
  }[state];
}

function formatExpiry(value?: string) {
  if (!value) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date(value));
}

function agentEventStatusLabel(status: string) {
  const labels: Record<string, string> = {
    received: "已接收",
    success: "成功",
    failed: "失败",
    blocked: "已拦截",
    pending: "待确认",
    local: "本地规划",
    "markdown-fallback": "文本降级"
  };
  return labels[status] ?? status;
}

export function QqNotificationPanel({
  setToast,
  open,
  onToggle
}: {
  setToast: (message: string) => void;
  open: boolean;
  onToggle: () => void;
}) {
  const [saved, setSaved] = useState<PublicQqBotSettings | null>(null);
  const [status, setStatus] = useState<QqBotPublicStatus | null>(null);
  const [form, setForm] = useState<QqForm | null>(null);
  const [binding, setBinding] = useState<QqBindingChallenge | null>(null);
  const [busy, setBusy] = useState("");
  const [agentRuns, setAgentRuns] = useState<QqAgentRun[]>([]);

  const refresh = useCallback(async () => {
    const [response, runs] = await Promise.all([api.qqStatus(), api.qqAgentRuns(8)]);
    setSaved(response.settings);
    setStatus(response.status);
    setAgentRuns(runs.items);
    setForm((current) => current ?? formFromSettings(response.settings));
  }, []);

  useEffect(() => {
    void refresh().catch(() => undefined);
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 4000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const configured = Boolean(form?.appId.trim() && (saved?.hasAppSecret || form?.appSecret.trim()));
  const online = status?.gateway.state === "online";
  const selectedCategoryText = useMemo(() => {
    if (!form) return "";
    return categories.filter((item) => form.notifyCategories[item.id]).map((item) => item.label).join("、") || "未选择";
  }, [form]);

  async function save() {
    if (!form) return;
    setBusy("save");
    try {
      const response = await api.updateNotificationChannels({ qq: form });
      setSaved(response.qq);
      setStatus(response.qqStatus);
      setForm({ ...formFromSettings(response.qq), appSecret: "" });
      setToast("QQ 通知设置已保存。");
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  }

  async function toggleConnection() {
    setBusy("connection");
    try {
      const next = online ? await api.stopQq() : await api.startQq();
      setStatus(next);
      setToast(online ? "QQ Gateway 已停止。" : "QQ Gateway 正在连接。");
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  }

  async function beginBinding() {
    if (!form) return;
    setBusy("binding");
    try {
      const settings = await api.updateNotificationChannels({ qq: { ...form, enabled: true } });
      setSaved(settings.qq);
      setForm({ ...formFromSettings(settings.qq), appSecret: "" });
      const result = await api.bindQq(Boolean(settings.qqStatus.bound));
      setBinding(result.binding);
      setStatus(result.status);
      setToast("绑定码已生成，请在 QQ 中发送给机器人。");
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  }

  async function testNotification() {
    setBusy("test");
    try {
      const result = await api.testQq();
      setStatus(result.status);
      setToast(result.message);
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  }

  function toggleCategory(category: MailCategory) {
    if (!form) return;
    setForm({
      ...form,
      notifyCategories: {
        ...form.notifyCategories,
        [category]: !form.notifyCategories[category]
      }
    });
  }

  function updateAgent(patch: Partial<QqAgentSettings>) {
    if (!form) return;
    setForm({
      ...form,
      agent: {
        ...form.agent,
        ...patch,
        permissions: patch.permissions ?? form.agent.permissions
      }
    });
  }

  function toggleAgentPermission(permission: QqAgentPermission) {
    if (!form) return;
    updateAgent({
      permissions: {
        ...form.agent.permissions,
        [permission]: !form.agent.permissions[permission]
      }
    });
  }

  return (
    <section
      className={`settings-panel settings-section qq-notification-panel ${open ? "is-open" : "is-collapsed"}`}
      data-settings-section="qq"
    >
      <button
        type="button"
        className="settings-section-toggle"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls="settings-section-qq"
      >
        <span className="settings-section-icon">
          <Robot size={20} weight="duotone" />
        </span>
        <span className="settings-section-heading">
          <small>QQ 通知</small>
          <strong>官方 QQ Bot</strong>
        </span>
        <span className={`settings-section-summary qq-live-status ${online ? "online" : status?.gateway.state === "blocked" ? "danger" : ""}`}>
          <span />
          {form?.enabled ? "通知已开启" : "通知未开启"} · {gatewayLabel(status)}
        </span>
        <span className="settings-section-caret" aria-hidden="true">
          <CaretDown size={17} />
        </span>
      </button>

      {open && (
        <div className="settings-section-body" id="settings-section-qq" role="region" aria-label="官方 QQ Bot 设置">
          {form ? (
            <div className="qq-notification-content">
              <button
                type="button"
                className={`notification-primary-toggle qq-primary-toggle${form.enabled ? " active" : ""}`}
                onClick={() => setForm({ ...form, enabled: !form.enabled })}
              >
                <span className="notification-toggle-icon">
                  <BellRinging size={22} weight={form.enabled ? "fill" : "regular"} />
                </span>
                <span className="notification-toggle-copy">
                  <strong>{form.enabled ? "QQ 通知已开启" : "开启 QQ 通知"}</strong>
                  <small>邮件入库后通过官方 Bot API 推送到已绑定的 QQ 单聊</small>
                </span>
                <em>{form.enabled ? "已开启" : "未开启"}</em>
              </button>

          <section className="qq-section qq-credentials-section">
            <div className="qq-section-heading">
              <div>
                <span>接入凭证</span>
                <strong>QQ 开放平台应用</strong>
              </div>
              <Plugs size={19} />
            </div>
            <div className="qq-field-grid">
              <label>
                AppID
                <input
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="输入机器人 AppID"
                  value={form.appId}
                  onChange={(event) => setForm({ ...form, appId: event.target.value.replace(/\D/g, "") })}
                />
              </label>
              <label>
                AppSecret
                <input
                  type="password"
                  autoComplete="new-password"
                  placeholder={saved?.hasAppSecret ? `已保存 ${saved.maskedAppSecret}，留空不修改` : "输入 AppSecret"}
                  value={form.appSecret}
                  onChange={(event) => setForm({ ...form, appSecret: event.target.value })}
                />
              </label>
            </div>
          </section>

          <section className="qq-section">
            <div className="qq-section-heading">
              <div>
                <span>通知范围</span>
                <strong>{selectedCategoryText}</strong>
              </div>
            </div>
            <div className="qq-category-row">
              {categories.map(({ id, label, icon: Icon }) => {
                const active = form.notifyCategories[id];
                return (
                  <button
                    type="button"
                    key={id}
                    className={`qq-category-option ${id}${active ? " active" : ""}`}
                    onClick={() => toggleCategory(id)}
                  >
                    <Icon size={18} />
                    <span>{label}</span>
                    <em>{active ? "发送" : "关闭"}</em>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="qq-section qq-quote-read-section">
            <button
              type="button"
              className={"qq-quote-read-toggle" + (form.quoteImageMarksRead ? " active" : "")}
              aria-pressed={form.quoteImageMarksRead}
              onClick={() => setForm({ ...form, quoteImageMarksRead: !form.quoteImageMarksRead })}
            >
              <span className="qq-quote-read-icon">
                <CheckCircle size={21} weight={form.quoteImageMarksRead ? "fill" : "regular"} />
              </span>
              <span className="qq-quote-read-copy">
                <strong>引用图片标记已读</strong>
                <small>在 QQ 引用邮件通知图片后，同步标记为系统已读并回复确认</small>
              </span>
              <span className={"switch-track" + (form.quoteImageMarksRead ? " on" : "")} aria-hidden="true">
                <span />
              </span>
            </button>
          </section>

          <section className="qq-section qq-agent-section">
            <button
              type="button"
              className={"qq-quote-read-toggle qq-agent-toggle" + (form.agent.enabled ? " active" : "")}
              aria-pressed={form.agent.enabled}
              onClick={() => updateAgent({ enabled: !form.agent.enabled })}
            >
              <span className="qq-quote-read-icon">
                <Robot size={21} weight={form.agent.enabled ? "fill" : "regular"} />
              </span>
              <span className="qq-quote-read-copy">
                <strong>{form.agent.enabled ? "QQ 智能体已开启" : "开启 QQ 智能体"}</strong>
                <small>已绑定的 QQ 用户可通过单聊查询邮件、管理通知队列并执行确认型动作</small>
              </span>
              <span className={"switch-track" + (form.agent.enabled ? " on" : "")} aria-hidden="true">
                <span />
              </span>
            </button>

            <div className="qq-agent-controls">
              <button
                type="button"
                className={"qq-agent-confirm-toggle" + (form.agent.requireConfirmation ? " active" : "")}
                aria-pressed={form.agent.requireConfirmation}
                onClick={() => updateAgent({ requireConfirmation: !form.agent.requireConfirmation })}
              >
                <ShieldCheck size={18} weight="duotone" />
                <span>写操作二次确认</span>
                <em>{form.agent.requireConfirmation ? "开启" : "关闭"}</em>
              </button>
              <label className="qq-agent-limit">
                每次结果
                <input
                  type="number"
                  min={3}
                  max={10}
                  value={form.agent.maxResults}
                  onChange={(event) => updateAgent({
                    maxResults: Math.min(10, Math.max(3, Math.floor(Number(event.target.value) || 6)))
                  })}
                />
              </label>
            </div>

            <div className="qq-agent-permission-grid">
              {agentPermissions.map((permission) => {
                const active = form.agent.permissions[permission.id];
                return (
                  <button
                    type="button"
                    key={permission.id}
                    className={"qq-agent-permission" + (active ? " active" : "")}
                    onClick={() => toggleAgentPermission(permission.id)}
                  >
                    <span>{permission.label}</span>
                    <small>{permission.detail}</small>
                    <em>{active ? "允许" : "关闭"}</em>
                  </button>
                );
              })}
            </div>

            <div className="qq-agent-isolation-status">
              <LockSimple size={18} weight="duotone" />
              <span>
                <strong>严格安全隔离</strong>
                <small>邮件和附件只作为不可信数据读取；写操作及文件导出必须由当前消息明确授权</small>
              </span>
              <em>强制</em>
            </div>

            <div className="qq-agent-runs">
              <div className="qq-agent-runs-heading">
                <span>
                  <Pulse size={18} />
                  智能体运行记录
                </span>
                <small>保留最近 200 次，日志自动脱敏</small>
              </div>
              {agentRuns.length ? agentRuns.map((run) => (
                <details className="qq-agent-run" key={run.id}>
                  <summary>
                    <span className={`qq-agent-run-state ${run.status}`} />
                    <strong>{run.message}</strong>
                    <small>
                      {new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(run.startedAt))}
                      {` · ${run.durationMs === undefined ? "运行中" : `${Math.max(1, Math.round(run.durationMs / 100) / 10)} 秒`}`}
                      {` · ${run.toolCallCount} 个工具`}
                    </small>
                  </summary>
                  <div className="qq-agent-run-events">
                    {run.events.map((event) => (
                      <div key={event.id}>
                        <span>{event.step === undefined ? "-" : event.step}</span>
                        <strong>{event.toolName ?? event.kind}</strong>
                        <em>{agentEventStatusLabel(event.status)}</em>
                        <small>{event.durationMs === undefined ? event.message : `${event.message ?? "完成"} · ${event.durationMs} ms`}</small>
                      </div>
                    ))}
                    {!run.events.length && <p>正在等待第一条执行记录。</p>}
                    {run.error && <p className="qq-agent-run-error">{run.error}</p>}
                  </div>
                </details>
              )) : <p className="qq-agent-runs-empty">还没有智能体运行记录。</p>}
            </div>
          </section>

          <section className="qq-section qq-binding-section">
            <div className="qq-binding-status">
              <span className="qq-binding-icon">
                {status?.bound ? <SealCheck size={21} weight="fill" /> : <LinkSimple size={21} />}
              </span>
              <div>
                <span>指定接收人</span>
                <strong>{status?.bound ? status.maskedRecipient : "尚未绑定 QQ 用户"}</strong>
                <small>
                  官方接口不使用 QQ 号。生成验证码后，用接收通知的 QQ 与机器人单聊并发送该验证码。
                </small>
              </div>
            </div>

            {binding && (
              <div className="qq-binding-code" aria-live="polite">
                <span>在机器人单聊中发送</span>
                <strong>{binding.code}</strong>
                <small>有效至 {formatExpiry(binding.expiresAt)}，仅可使用一次</small>
              </div>
            )}

            <div className="qq-status-grid">
              <div>
                <span>Gateway</span>
                <strong>{gatewayLabel(status)}</strong>
              </div>
              <div>
                <span>好友关系</span>
                <strong>{status?.friendshipStatus === "friend" ? "正常" : status?.bound ? "待确认" : "未绑定"}</strong>
              </div>
              <div>
                <span>主动推送</span>
                <strong>{status?.proactiveStatus === "enabled" ? "可发送" : status?.bound ? "待验证" : "未验证"}</strong>
              </div>
            </div>
          </section>

          {status?.gateway.lastError && (
            <p className="qq-inline-error">连接状态：{status.gateway.lastError.message}</p>
          )}

          <div className="qq-actions">
            <button className="secondary-button" disabled={Boolean(busy)} onClick={save}>
              <FloppyDisk size={18} />
              保存 QQ 设置
            </button>
            <button className="ghost-button" disabled={Boolean(busy) || !configured} onClick={toggleConnection}>
              <Plugs size={18} />
              {busy === "connection" ? "处理中..." : online ? "停止 Gateway" : "连接 Gateway"}
            </button>
            <button className="ghost-button" disabled={Boolean(busy) || !configured} onClick={beginBinding}>
              <LinkSimple size={18} />
              {status?.bound ? "重新绑定" : "绑定接收人"}
            </button>
            <button className="ghost-button" disabled={Boolean(busy) || !status?.bound} onClick={testNotification}>
              <PaperPlaneTilt size={18} />
              测试 QQ 通知
            </button>
          </div>
            </div>
          ) : (
            <div className="qq-panel-loading" aria-label="正在加载 QQ 通知设置">
              <span />
              <span />
              <span />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
