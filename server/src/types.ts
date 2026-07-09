export type MailProtocol = "imap" | "pop3";
export type MailCategory = "important" | "secondary" | "ignore";
export type RunStatus = "running" | "success" | "failed";

export type AiSettings = {
  providerName: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
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
};

export type ProcessedEmail = {
  id: string;
  mailboxId: string;
  externalUid: string;
  messageId?: string;
  subject: string;
  fromName?: string;
  fromAddress?: string;
  toText?: string;
  receivedAt?: string;
  processedAt: string;
  category: MailCategory;
  summaryZh: string;
  reasonZh: string;
  actionItemsZh: string[];
  originalText: string;
  originalHtml?: string;
  rawSource?: string;
  readMarked: boolean;
  readMarkNote?: string;
};

export type ProcessingRun = {
  id: string;
  startedAt: string;
  finishedAt?: string;
  status: RunStatus;
  mailboxId?: string;
  processedCount: number;
  importantCount: number;
  secondaryCount: number;
  ignoreCount: number;
  errors: string[];
};

export type AppState = {
  settings: {
    ai: AiSettings;
    system: SystemSettings;
  };
  mailboxes: Mailbox[];
  emails: ProcessedEmail[];
  runs: ProcessingRun[];
};

export type IncomingEmail = {
  mailboxId: string;
  externalUid: string;
  messageId?: string;
  subject: string;
  fromName?: string;
  fromAddress?: string;
  toText?: string;
  receivedAt?: string;
  originalText: string;
  originalHtml?: string;
  rawSource?: string;
};

export type ClassificationResult = {
  category: MailCategory;
  summaryZh: string;
  reasonZh: string;
  actionItemsZh: string[];
};
