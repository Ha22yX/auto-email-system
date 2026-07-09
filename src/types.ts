export type MailCategory = "important" | "secondary" | "ignore";
export type MailProtocol = "imap" | "pop3";

export type AiSettings = {
  providerName: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  multimodalEnabled: boolean;
  multimodalBaseUrl: string;
  multimodalModel: string;
  multimodalMaxAttachmentMb: number;
  multimodalMaxTotalMb: number;
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

export type AuthSettings = {
  passwordUpdatedAt: string;
  sessionDays: number;
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
  attachments?: EmailAttachment[];
  multimodalAnalysis?: MultimodalAnalysis;
};

export type EmailAttachment = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  contentId?: string;
  disposition?: string;
  related: boolean;
  supportedForVision: boolean;
};

export type MultimodalAnalysis = {
  model: string;
  summaryZh: string;
  reasonZh: string;
  categoryHint?: MailCategory;
  importantSignalsZh: string[];
  analyzedAt: string;
  attachmentCount: number;
  analyzedAttachmentNames: string[];
  skippedAttachmentNames: string[];
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
    auth: AuthSettings;
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
  runtimeMode?: "node-ilink";
  runtimeName?: string;
  executablePath: string;
  legacyExecutablePath?: string;
  legacyExecutableAvailable?: boolean;
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
  sessionExpired?: boolean;
  sessionExpiredAt?: string;
  missingContext?: boolean;
  missingContextAt?: string;
  lastExit?: {
    code: number | null;
    signal: string | null;
    at: string;
  };
  logTail: string;
  message?: string;
};
