import type {
  AiSettings,
  AiBillingProvider,
  AiCostSnapshot,
  AiUsageDashboard,
  AiUsageRange,
  AuthSettings,
  ClassificationResult,
  Dashboard,
  EmailListPage,
  MailCategory,
  Mailbox,
  NotificationDeliveryItem,
  NotificationDeliveryPage,
  NotificationDeliveryStatus,
  NotificationSettings,
  NotificationSettingsResponse,
  ProcessedEmail,
  ProcessingRun,
  PublicQqBotSettings,
  PublicAiBillingSettings,
  QqBindingChallenge,
  QqAgentRun,
  QqBotPublicStatus,
  QqBotSettingsInput,
  SystemSettings,
  WeclawStatus
} from "./types";

const API_BASE =
  import.meta.env.VITE_API_BASE_URL ??
  (window.location.port === "5173" ? "http://127.0.0.1:8787" : "");

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(body.error || `请求失败: ${response.status}`, response.status);
  }

  return response.json() as Promise<T>;
}

export const api = {
  eventsUrl() {
    return `${API_BASE}/api/events`;
  },
  authSession() {
    return request<{ authenticated: boolean; auth: AuthSettings }>("/api/auth/session");
  },
  login(password: string) {
    return request<{ authenticated: boolean; auth: AuthSettings }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password })
    });
  },
  logout() {
    return request<{ authenticated: boolean }>("/api/auth/logout", { method: "POST" });
  },
  dashboard(mailboxId = "all") {
    return request<Dashboard>(`/api/dashboard?mailboxId=${encodeURIComponent(mailboxId)}`);
  },
  aiUsage(range: AiUsageRange, startAt: string | undefined, endAt: string, timeZone: string) {
    const params = new URLSearchParams({ range, endAt, timeZone });
    if (startAt) params.set("startAt", startAt);
    return request<AiUsageDashboard>(`/api/ai-usage?${params.toString()}`);
  },
  updateAiBilling(provider: AiBillingProvider, adminKey = "") {
    return request<PublicAiBillingSettings>("/api/ai-usage/billing", {
      method: "PUT",
      body: JSON.stringify({ provider, adminKey })
    });
  },
  syncAiCosts(range: AiUsageRange, startAt: string | undefined, endAt: string) {
    return request<AiCostSnapshot>("/api/ai-usage/costs/sync", {
      method: "POST",
      body: JSON.stringify({ range, startAt, endAt })
    });
  },
  emails(category: MailCategory, mailboxId: string, q: string, offset = 0, limit = 40) {
    const params = new URLSearchParams({
      category,
      mailboxId,
      q,
      offset: String(offset),
      limit: String(limit)
    });
    return request<EmailListPage>(`/api/emails?${params.toString()}`);
  },
  notifications(status: NotificationDeliveryStatus | "failed" = "failed", offset = 0, limit = 40) {
    const params = new URLSearchParams({
      channel: "qq",
      status,
      offset: String(offset),
      limit: String(limit)
    });
    return request<NotificationDeliveryPage>(`/api/notifications?${params.toString()}`);
  },
  retryNotification(id: string) {
    return request<NotificationDeliveryItem>(`/api/notifications/${encodeURIComponent(id)}/retry`, {
      method: "POST"
    });
  },
  pauseNotification(id: string) {
    return request<NotificationDeliveryItem>(`/api/notifications/${encodeURIComponent(id)}/pause`, {
      method: "POST"
    });
  },
  resumeNotification(id: string) {
    return request<NotificationDeliveryItem>(`/api/notifications/${encodeURIComponent(id)}/resume`, {
      method: "POST"
    });
  },
  retryAllQqNotifications() {
    return request<{ updatedCount: number }>("/api/notifications/qq/retry-all", { method: "POST" });
  },
  email(id: string) {
    return request<ProcessedEmail>(`/api/emails/${id}`);
  },
  markEmailsRead(category: MailCategory, mailboxId: string) {
    return request<{
      updatedCount: number;
      updatedAt: string;
      operationId?: string;
      undoExpiresAt?: string;
    }>("/api/emails/read-state", {
      method: "PATCH",
      body: JSON.stringify({ category, mailboxId })
    });
  },
  undoMarkEmailsRead(operationId: string) {
    return request<{ restoredCount: number; restoredAt: string }>("/api/emails/read-state/undo", {
      method: "PATCH",
      body: JSON.stringify({ operationId })
    });
  },
  updateEmailReadState(id: string, panelRead: boolean) {
    return request<ProcessedEmail>(`/api/emails/${id}/read-state`, {
      method: "PATCH",
      body: JSON.stringify({ panelRead })
    });
  },
  updateAi(settings: AiSettings) {
    return request<AiSettings>("/api/settings/ai", {
      method: "PUT",
      body: JSON.stringify(settings)
    });
  },
  testAi(settings: AiSettings) {
    return request<{
      ok: boolean;
      message: string;
      provider: string;
      protocol: AiSettings["protocol"];
      endpoint: string;
      model: string;
      category: MailCategory;
      result?: ClassificationResult;
    }>("/api/settings/ai/test", {
      method: "POST",
      body: JSON.stringify(settings)
    });
  },
  updateSystem(settings: SystemSettings) {
    return request<SystemSettings>("/api/settings/system", {
      method: "PUT",
      body: JSON.stringify(settings)
    });
  },
  updateAuthPassword(currentPassword: string, newPassword: string) {
    return request<AuthSettings>("/api/settings/auth/password", {
      method: "PUT",
      body: JSON.stringify({ currentPassword, newPassword })
    });
  },
  updateNotification(settings: NotificationSettings) {
    return request<NotificationSettings>("/api/settings/notification", {
      method: "PUT",
      body: JSON.stringify(settings)
    });
  },
  notificationSettings() {
    return request<NotificationSettingsResponse>("/api/settings/notification");
  },
  updateNotificationChannels(settings: { wechat?: NotificationSettings; qq?: QqBotSettingsInput }) {
    return request<NotificationSettingsResponse>("/api/settings/notification", {
      method: "PUT",
      body: JSON.stringify(settings)
    });
  },
  qqStatus() {
    return request<{ settings: PublicQqBotSettings; status: QqBotPublicStatus }>("/api/qq/status");
  },
  qqAgentRuns(limit = 12) {
    return request<{ items: QqAgentRun[] }>(`/api/qq/agent/runs?limit=${encodeURIComponent(String(limit))}`);
  },
  startQq() {
    return request<QqBotPublicStatus>("/api/qq/start", { method: "POST" });
  },
  stopQq() {
    return request<QqBotPublicStatus>("/api/qq/stop", { method: "POST" });
  },
  bindQq(rebind = false) {
    return request<{ binding: QqBindingChallenge; status: QqBotPublicStatus }>(
      rebind ? "/api/qq/rebind" : "/api/qq/bind",
      { method: "POST" }
    );
  },
  testQq() {
    return request<{ ok: boolean; message: string; status: QqBotPublicStatus }>("/api/qq/test", {
      method: "POST"
    });
  },
  testNotification(settings: NotificationSettings) {
    return request<{ ok: boolean; message: string }>("/api/settings/notification/test", {
      method: "POST",
      body: JSON.stringify(settings)
    });
  },
  weclawStatus() {
    return request<WeclawStatus>("/api/weclaw/status");
  },
  startWeclaw() {
    return request<WeclawStatus>("/api/weclaw/start", { method: "POST" });
  },
  stopWeclaw() {
    return request<WeclawStatus>("/api/weclaw/stop", { method: "POST" });
  },
  rebindWeclaw() {
    return request<WeclawStatus>("/api/weclaw/rebind", { method: "POST" });
  },
  weclawLogs(lines = 160) {
    return request<{ logTail: string; logFile: string }>(`/api/weclaw/logs?lines=${encodeURIComponent(String(lines))}`);
  },
  saveMailbox(mailbox: Partial<Mailbox>) {
    return request<Mailbox[]>(mailbox.id ? `/api/mailboxes/${mailbox.id}` : "/api/mailboxes", {
      method: mailbox.id ? "PUT" : "POST",
      body: JSON.stringify(mailbox)
    });
  },
  deleteMailbox(id: string) {
    return request<{ ok: boolean }>(`/api/mailboxes/${id}`, { method: "DELETE" });
  },
  testMailbox(id: string) {
    return request<{ ok: boolean; message: string }>(`/api/mailboxes/${id}/test`, { method: "POST" });
  },
  run(mailboxId?: string) {
    return request<ProcessingRun>("/api/process/run", {
      method: "POST",
      body: JSON.stringify({ mailboxId: mailboxId === "all" ? undefined : mailboxId })
    });
  }
};
