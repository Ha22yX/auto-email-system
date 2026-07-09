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
  updateAi(settings: AiSettings) {
    return request<AiSettings>("/api/settings/ai", {
      method: "PUT",
      body: JSON.stringify(settings)
    });
  },
  updateSystem(settings: SystemSettings) {
    return request<SystemSettings>("/api/settings/system", {
      method: "PUT",
      body: JSON.stringify(settings)
    });
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
