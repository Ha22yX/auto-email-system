import type {
  AiSettings,
  Dashboard,
  EmailListItem,
  MailCategory,
  Mailbox,
  NotificationSettings,
  ProcessedEmail,
  ProcessingRun,
  SystemSettings,
  WeclawStatus
} from "./types";

const API_BASE =
  import.meta.env.VITE_API_BASE_URL ??
  (window.location.port === "5173" ? "http://127.0.0.1:8787" : "");

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `请求失败: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export const api = {
  dashboard(mailboxId = "all") {
    return request<Dashboard>(`/api/dashboard?mailboxId=${encodeURIComponent(mailboxId)}`);
  },
  emails(category: MailCategory, mailboxId: string, q: string) {
    const params = new URLSearchParams({ category, mailboxId, q });
    return request<EmailListItem[]>(`/api/emails?${params.toString()}`);
  },
  email(id: string) {
    return request<ProcessedEmail>(`/api/emails/${id}`);
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
    return request<{ ok: boolean; message: string }>("/api/settings/ai/test", {
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
  updateNotification(settings: NotificationSettings) {
    return request<NotificationSettings>("/api/settings/notification", {
      method: "PUT",
      body: JSON.stringify(settings)
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
