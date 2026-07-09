export type MailCategory = "important" | "secondary" | "ignore";
export type MailProtocol = "imap" | "pop3";

export type AiSettings = {
  providerName: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  hasApiKey?: boolean;
  maskedApiKey?: string;
};

export type SystemSettings = {
  autoProcessEnabled: boolean;
  pollIntervalMinutes: number;
  processLimitPerMailbox: number;
};

export type Mailbox = {
  id: string;
  name: string;
  email: string;
  protocol: MailProtocol;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  folder: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastSyncAt?: string;
  lastError?: string;
  hasPassword?: boolean;
};

export type EmailListItem = {
  id: string;
  mailboxId: string;
  subject: string;
  fromName?: string;
  fromAddress?: string;
  receivedAt?: string;
  processedAt: string;
  category: MailCategory;
  summaryZh: string;
  reasonZh: string;
  actionItemsZh: string[];
  readMarked: boolean;
  readMarkNote?: string;
};

export type ProcessedEmail = EmailListItem & {
  messageId?: string;
  toText?: string;
  originalText: string;
  originalHtml?: string;
  rawSource?: string;
};

export type ProcessingRun = {
  id: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "success" | "failed";
  mailboxId?: string;
  processedCount: number;
  importantCount: number;
  secondaryCount: number;
  ignoreCount: number;
  errors: string[];
};

export type Dashboard = {
  settings: {
    ai: AiSettings;
    system: SystemSettings;
  };
  mailboxes: Mailbox[];
  counts: Record<MailCategory, number>;
  total: number;
  recentEmails: EmailListItem[];
  runs: ProcessingRun[];
  processorRunning: boolean;
};
