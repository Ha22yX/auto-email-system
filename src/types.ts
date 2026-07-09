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
  autoLoadRemoteImages: boolean;
  pollIntervalMinutes: number;
  processLimitPerMailbox: number;
};

export type NotificationSettings = {
  enabled: boolean;
  clawbotApiUrl: string;
  clawbotRecipientId: string;
  importantOnly: boolean;
  notifyCategories: Record<MailCategory, boolean>;
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
  panelRead: boolean;
  panelReadAt?: string;
  readMarked: boolean;
  readMarkNote?: string;
  notifiedAt?: string;
  notificationError?: string;
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
  totalMailboxCount?: number;
  currentMailboxIndex?: number;
  currentMailboxName?: string;
  currentSubject?: string;
  currentStage?: string;
  totalTaskCount?: number;
  handledTaskCount?: number;
  totalUnreadCount?: number;
  handledUnreadCount?: number;
  currentMailboxUnreadCount?: number;
  currentMailboxHandledCount?: number;
  currentEmailStep?: string;
  currentEmailStepIndex?: number;
  currentEmailStepTotal?: number;
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
    notification: NotificationSettings;
  };
  mailboxes: Mailbox[];
  counts: Record<MailCategory, number>;
  unreadCounts: Record<MailCategory, number>;
  total: number;
  allTotal: number;
  recentEmails: EmailListItem[];
  runs: ProcessingRun[];
  processorRunning: boolean;
  currentRun?: ProcessingRun | null;
};

export type WeclawStatus = {
  installed: boolean;
  executablePath: string;
  apiUrl: string;
  apiBaseUrl: string;
  apiReachable: boolean;
  running: boolean;
  managedRunning: boolean;
  managedPid?: number;
  hasCredentials: boolean;
  credentialCount: number;
  credentialsPath: string;
  recipientId?: string;
  botId?: string;
  contextTokenPath?: string;
  contextReady?: boolean;
  contextUpdatedAt?: string;
  lastExit?: {
    code: number | null;
    signal: string | null;
    at: string;
  };
  logTail: string;
  message?: string;
};
