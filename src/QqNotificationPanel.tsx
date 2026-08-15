import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Archive,
  BellRinging,
  FloppyDisk,
  LinkSimple,
  PaperPlaneTilt,
  Plugs,
  SealCheck,
  Star,
  Warning
} from "@phosphor-icons/react";
import { api } from "./api";
import "./qq-notification.css";
import type {
  MailCategory,
  PublicQqBotSettings,
  QqBindingChallenge,
  QqBotPublicStatus
} from "./types";

type QqForm = {
  appId: string;
  appSecret: string;
  enabled: boolean;
  notifyCategories: Record<MailCategory, boolean>;
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

function formFromSettings(settings: PublicQqBotSettings): QqForm {
  return {
    appId: settings.appId,
    appSecret: "",
    enabled: settings.enabled,
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

export function QqNotificationPanel({ setToast }: { setToast: (message: string) => void }) {
  const [saved, setSaved] = useState<PublicQqBotSettings | null>(null);
  const [status, setStatus] = useState<QqBotPublicStatus | null>(null);
  const [form, setForm] = useState<QqForm | null>(null);
  const [binding, setBinding] = useState<QqBindingChallenge | null>(null);
  const [busy, setBusy] = useState("");

  const refresh = useCallback(async () => {
    const response = await api.qqStatus();
    setSaved(response.settings);
    setStatus(response.status);
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

  return (
    <div className="settings-panel qq-notification-panel">
      <div className="panel-heading qq-panel-heading">
        <div>
          <p className="section-kicker">QQ 通知</p>
          <h2>官方 QQ Bot</h2>
        </div>
        <span className={`qq-live-status ${online ? "online" : status?.gateway.state === "blocked" ? "danger" : ""}`}>
          <span />
          {gatewayLabel(status)}
        </span>
      </div>

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
  );
}
