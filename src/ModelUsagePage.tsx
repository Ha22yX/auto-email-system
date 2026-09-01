import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowClockwise,
  ChartLineUp,
  CheckCircle,
  Coins,
  Database,
  Key,
  Robot,
  Warning
} from "@phosphor-icons/react";
import { api } from "./api";
import type {
  AiBillingProvider,
  AiUsageDashboard,
  AiUsagePurpose,
  AiUsageRange,
  AiUsageScope
} from "./types";

const ranges: Array<{ value: AiUsageRange; label: string }> = [
  { value: "today", label: "今天" },
  { value: "7d", label: "过去 7 天" },
  { value: "30d", label: "过去 30 天" },
  { value: "all", label: "全部" }
];

const scopeLabels: Record<AiUsageScope, string> = {
  email: "邮件入库分析",
  agent: "QQ 智能体",
  system: "系统与测试"
};

const purposeLabels: Record<AiUsagePurpose, string> = {
  email_classification: "邮件正文分析",
  email_multimodal: "图片与 PDF 识别",
  agent_orchestration: "智能体规划",
  agent_response: "智能体回复",
  agent_attachment: "智能体附件分析",
  system_test: "API 连通性测试"
};

function usageWindow(range: AiUsageRange) {
  const end = new Date();
  if (range === "all") return { startAt: undefined, endAt: end.toISOString() };
  const start = new Date(end);
  start.setHours(0, 0, 0, 0);
  if (range === "7d") start.setDate(start.getDate() - 6);
  if (range === "30d") start.setDate(start.getDate() - 29);
  return { startAt: start.toISOString(), endAt: end.toISOString() };
}

function compactNumber(value: number) {
  return new Intl.NumberFormat("zh-CN", {
    notation: value >= 10000 ? "compact" : "standard",
    maximumFractionDigits: value >= 10000 ? 1 : 0
  }).format(value);
}

function preciseNumber(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function percent(value: number) {
  return new Intl.NumberFormat("zh-CN", {
    style: "percent",
    maximumFractionDigits: 1
  }).format(value);
}

function dateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function duration(value: number) {
  if (value < 1000) return `${value} ms`;
  return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)} s`;
}

function timelineLabel(bucket: string, range: AiUsageRange) {
  if (range === "today") return `${bucket.slice(11, 13)}:00`;
  if (range === "all") return bucket.replace("-", "/");
  return bucket.slice(5).replace("-", "/");
}

function costText(dashboard: AiUsageDashboard | undefined) {
  const snapshot = dashboard?.billing.latestCost;
  if (!snapshot) return "尚未同步";
  const amounts = snapshot.amounts;
  if (!amounts.length) return "$0.00";
  return amounts
    .map((item) => new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: item.currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 4
    }).format(item.amount))
    .join(" + ");
}

export function ModelUsagePage() {
  const [range, setRange] = useState<AiUsageRange>("today");
  const [dashboard, setDashboard] = useState<AiUsageDashboard>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [billingProvider, setBillingProvider] = useState<AiBillingProvider>("none");
  const [adminKey, setAdminKey] = useState("");
  const [billingBusy, setBillingBusy] = useState<"save" | "sync" | "">("");
  const [billingMessage, setBillingMessage] = useState("");

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError("");
    try {
      const window = usageWindow(range);
      const next = await api.aiUsage(
        range,
        window.startAt,
        window.endAt,
        Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
      );
      setDashboard(next);
      setBillingProvider(next.billing.settings.provider);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "模型用量加载失败。");
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(true), 60000);
    return () => window.clearInterval(timer);
  }, [load]);

  const saveBilling = async () => {
    setBillingBusy("save");
    setBillingMessage("");
    try {
      const saved = await api.updateAiBilling(billingProvider, adminKey);
      setAdminKey("");
      setBillingMessage(saved.provider === "none" ? "已关闭供应商账单同步。" : "账单设置已保存。密钥已加密存储。" );
      await load(true);
    } catch (saveError) {
      setBillingMessage(saveError instanceof Error ? saveError.message : "账单设置保存失败。");
    } finally {
      setBillingBusy("");
    }
  };

  const syncCosts = async () => {
    setBillingBusy("sync");
    setBillingMessage("");
    try {
      if (billingProvider !== dashboard?.billing.settings.provider || adminKey.trim()) {
        await api.updateAiBilling(billingProvider, adminKey);
        setAdminKey("");
      }
      const window = usageWindow(range);
      const snapshot = await api.syncAiCosts(range, window.startAt, window.endAt);
      setBillingMessage(`已同步 ${snapshot.provider === "openai" ? "OpenAI" : "Anthropic"} 组织账单。`);
      await load(true);
    } catch (syncError) {
      setBillingMessage(syncError instanceof Error ? syncError.message : "账单同步失败。");
    } finally {
      setBillingBusy("");
    }
  };

  const maxTimelineTokens = useMemo(
    () => Math.max(1, ...(dashboard?.timeline.map((item) => item.totalTokens) ?? [1])),
    [dashboard]
  );
  const missingUsageCalls = Math.max(
    0,
    (dashboard?.totals.successfulCalls ?? 0) - (dashboard?.totals.usageReportedCalls ?? 0)
  );

  return (
    <section className="usage-page">
      <div className="usage-toolbar">
        <div className="usage-range" role="group" aria-label="用量时间范围">
          {ranges.map((item) => (
            <button
              type="button"
              key={item.value}
              className={range === item.value ? "active" : ""}
              onClick={() => setRange(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="ghost-button usage-refresh"
          onClick={() => void load()}
          disabled={loading}
          aria-label="刷新模型用量"
          title="刷新模型用量"
        >
          <ArrowClockwise size={17} className={loading ? "spinning" : ""} />
          <span>刷新</span>
        </button>
      </div>

      {error && <div className="usage-error"><Warning size={18} />{error}</div>}

      <div className={loading && !dashboard ? "usage-summary loading" : "usage-summary"}>
        <div className="usage-metric">
          <span>模型调用</span>
          <strong>{compactNumber(dashboard?.totals.calls ?? 0)}</strong>
          <small>{dashboard?.totals.failedCalls ? `${dashboard.totals.failedCalls} 次失败` : "全部调用正常"}</small>
        </div>
        <div className="usage-metric">
          <span>输入 Token</span>
          <strong>{compactNumber(dashboard?.totals.inputTokens ?? 0)}</strong>
          <small>{preciseNumber(dashboard?.totals.inputTokens ?? 0)} tokens</small>
        </div>
        <div className="usage-metric">
          <span>输出 Token</span>
          <strong>{compactNumber(dashboard?.totals.outputTokens ?? 0)}</strong>
          <small>{preciseNumber(dashboard?.totals.outputTokens ?? 0)} tokens</small>
        </div>
        <div className="usage-metric">
          <span>缓存命中率</span>
          <strong>{percent(dashboard?.totals.cacheHitRate ?? 0)}</strong>
          <small>{compactNumber(dashboard?.totals.cachedInputTokens ?? 0)} 个缓存输入</small>
        </div>
        <div className="usage-metric cost">
          <span>供应商实际花费</span>
          <strong>{costText(dashboard)}</strong>
          <small>{dashboard?.billing.latestCost ? `${dateTime(dashboard.billing.latestCost.queriedAt)} 同步` : "需要管理员账单密钥"}</small>
        </div>
      </div>

      {missingUsageCalls > 0 && (
        <div className="usage-note">
          <Warning size={17} />
          有 {missingUsageCalls} 次成功调用的代理接口没有返回 token 字段；调用次数已记录，但 token 统计不包含这些请求。
        </div>
      )}

      <div className="usage-main-grid">
        <section className="usage-section usage-activity">
          <header>
            <div>
              <span className="section-kicker">调用趋势</span>
              <h2>Token 时间分布</h2>
            </div>
            <ChartLineUp size={23} />
          </header>
          {dashboard?.timeline.length ? (
            <div className="usage-chart" aria-label="Token 时间分布图">
              {dashboard.timeline.map((item) => (
                <div className="usage-chart-column" key={item.bucket} title={`${timelineLabel(item.bucket, range)} · ${preciseNumber(item.totalTokens)} tokens · ${item.calls} 次`}>
                  <div className="usage-chart-value">{compactNumber(item.totalTokens)}</div>
                  <div className="usage-chart-track">
                    <span style={{ height: `${Math.max(5, (item.totalTokens / maxTimelineTokens) * 100)}%` }} />
                  </div>
                  <small>{timelineLabel(item.bucket, range)}</small>
                </div>
              ))}
            </div>
          ) : (
            <div className="usage-empty">当前范围还没有模型调用。</div>
          )}
        </section>

        <section className="usage-section usage-scope-section">
          <header>
            <div>
              <span className="section-kicker">业务归属</span>
              <h2>调用量分布</h2>
            </div>
            <Database size={23} />
          </header>
          <div className="usage-scope-list">
            {dashboard?.byScope.map((item) => {
              const share = dashboard.totals.totalTokens > 0 ? item.totalTokens / dashboard.totals.totalTokens : 0;
              const Icon = item.scope === "agent" ? Robot : item.scope === "email" ? Database : CheckCircle;
              return (
                <div className={`usage-scope-row ${item.scope}`} key={item.scope}>
                  <Icon size={20} />
                  <div>
                    <div><strong>{scopeLabels[item.scope]}</strong><span>{item.calls} 次</span></div>
                    <div className="usage-share-track"><span style={{ width: `${share * 100}%` }} /></div>
                  </div>
                  <b>{compactNumber(item.totalTokens)}</b>
                </div>
              );
            })}
          </div>
        </section>
      </div>

      <section className="usage-section usage-models">
        <header>
          <div>
            <span className="section-kicker">历史模型</span>
            <h2>服务商与模型明细</h2>
          </div>
          <span className="usage-header-meta">切换模型后仍按调用时配置分别统计</span>
        </header>
        <div className="usage-table-wrap">
          <table className="usage-table">
            <thead>
              <tr><th>服务商 / 模型</th><th>协议</th><th>调用</th><th>输入</th><th>缓存</th><th>输出</th><th>合计</th></tr>
            </thead>
            <tbody>
              {dashboard?.byModel.length ? dashboard.byModel.map((item) => (
                <tr key={item.key}>
                  <td><strong>{item.model}</strong><span>{item.provider}</span></td>
                  <td><code>{item.protocol}</code></td>
                  <td>{preciseNumber(item.calls)}</td>
                  <td>{preciseNumber(item.inputTokens)}</td>
                  <td>{preciseNumber(item.cachedInputTokens)} <small>{percent(item.cacheHitRate)}</small></td>
                  <td>{preciseNumber(item.outputTokens)}</td>
                  <td><strong>{preciseNumber(item.totalTokens)}</strong></td>
                </tr>
              )) : (
                <tr><td colSpan={7} className="usage-table-empty">当前范围没有模型数据。</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="usage-section usage-billing">
        <header>
          <div>
            <span className="section-kicker">账单核对</span>
            <h2>供应商费用 API</h2>
          </div>
          <Coins size={23} />
        </header>
        <div className="usage-billing-form">
          <label>
            <span>账单来源</span>
            <select value={billingProvider} onChange={(event) => setBillingProvider(event.target.value as AiBillingProvider)}>
              <option value="none">不启用</option>
              <option value="openai">OpenAI 组织账单</option>
              <option value="anthropic">Anthropic 组织账单</option>
            </select>
          </label>
          <label>
            <span>管理员密钥</span>
            <div className="usage-key-input">
              <Key size={17} />
              <input
                type="password"
                value={adminKey}
                onChange={(event) => setAdminKey(event.target.value)}
                placeholder={dashboard?.billing.settings.hasAdminKey && billingProvider === dashboard.billing.settings.provider
                  ? "已保存，留空不修改"
                  : "输入 Admin API Key"}
                disabled={billingProvider === "none"}
                autoComplete="new-password"
              />
            </div>
          </label>
          <div className="usage-billing-actions">
            <button type="button" className="secondary-button" onClick={() => void saveBilling()} disabled={Boolean(billingBusy)}>
              {billingBusy === "save" ? "保存中" : "保存设置"}
            </button>
            <button type="button" className="primary-button" onClick={() => void syncCosts()} disabled={Boolean(billingBusy) || billingProvider === "none"}>
              <ArrowClockwise size={17} className={billingBusy === "sync" ? "spinning" : ""} />
              {billingBusy === "sync" ? "同步中" : "同步当前范围"}
            </button>
          </div>
        </div>
        <div className="usage-billing-foot">
          <p>管理员密钥使用 AES-256-GCM 加密保存。供应商账单是整个组织在当前时间范围内的真实费用，可能包含本系统之外的调用。</p>
          {billingMessage && <strong>{billingMessage}</strong>}
        </div>
      </section>

      <section className="usage-section usage-recent">
        <header>
          <div>
            <span className="section-kicker">逐次记录</span>
            <h2>最近调用</h2>
          </div>
          <span className="usage-header-meta">只记录计量元数据，不保存提示词或邮件内容</span>
        </header>
        <div className="usage-table-wrap">
          <table className="usage-table recent">
            <thead>
              <tr><th>时间</th><th>用途</th><th>模型</th><th>输入 / 输出</th><th>缓存</th><th>耗时</th><th>状态</th></tr>
            </thead>
            <tbody>
              {dashboard?.recent.length ? dashboard.recent.map((item) => (
                <tr key={item.id}>
                  <td><time>{dateTime(item.occurredAt)}</time></td>
                  <td><strong>{purposeLabels[item.purpose]}</strong><span>{scopeLabels[item.scope]}</span></td>
                  <td><strong>{item.model}</strong><span>{item.provider}</span></td>
                  <td>{preciseNumber(item.inputTokens)} / {preciseNumber(item.outputTokens)}</td>
                  <td>{preciseNumber(item.cachedInputTokens)}</td>
                  <td>{duration(item.latencyMs)}</td>
                  <td>
                    <span className={item.success ? "usage-status success" : "usage-status failed"} title={item.error}>
                      {item.success ? "成功" : "失败"}
                    </span>
                  </td>
                </tr>
              )) : (
                <tr><td colSpan={7} className="usage-table-empty">还没有逐次调用记录。</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}
