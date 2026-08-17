import { publishAppEvent } from "../events";
import {
  createQqEmailReadAction,
  deleteQqEmailReadAction,
  finalizeQqEmailReadAction,
  readQqBotConfig,
  recordQqNotificationReference,
  resumePausedNotificationDeliveries
} from "../store";
import type { QqBotBinding, QqBotConfig } from "../types";
import { createQqBindingService, type QqBindingChallenge, type QqBindingService } from "./binding";
import { createQqButtonReadService, type QqButtonReadService } from "./button-read";
import { createQqClient } from "./client";
import { createTokenProvider } from "./credentials";
import { createQqGateway } from "./gateway";
import { createQqMarkdownAsset, removeQqMarkdownAsset } from "./markdown-assets";
import { createQqQuoteReadService, type QqQuoteReadService } from "./quote-read";
import type {
  QqBotPublicStatus,
  QqDirectImageInput,
  QqDirectMarkdownImageInput,
  QqDirectMessageInput,
  QqDispatchEvent,
  QqGatewayStatus,
  QqSendResult
} from "./types";
import { QqApiError } from "./types";

type QqManagerGateway = {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): QqGatewayStatus;
  onDispatch(listener: (event: QqDispatchEvent) => void): () => void;
};

type QqManagerBindingService = Pick<
  QqBindingService,
  "readBinding" | "readChallenge" | "createBindingCode" | "handleDispatchEvent"
>;

type QqManagerQuoteReadService = Pick<QqQuoteReadService, "handleDispatchEvent">;
type QqManagerButtonReadService = Pick<QqButtonReadService, "handleDispatchEvent">;

type QqManagerClient = {
  sendDirectMessage(input: QqDirectMessageInput): Promise<QqSendResult>;
  sendDirectImage(input: QqDirectImageInput): Promise<QqSendResult>;
  sendDirectMarkdownImage(input: QqDirectMarkdownImageInput): Promise<QqSendResult>;
  acknowledgeInteraction(interactionId: string): Promise<void>;
};

export type QqManagerDependencies = {
  readConfig?: () => QqBotConfig;
  gateway?: QqManagerGateway;
  bindingService?: QqManagerBindingService;
  quoteReadService?: QqManagerQuoteReadService;
  buttonReadService?: QqManagerButtonReadService;
  client?: QqManagerClient;
  recordMessageReference?: typeof recordQqNotificationReference;
  createReadAction?: typeof createQqEmailReadAction;
  finalizeReadAction?: typeof finalizeQqEmailReadAction;
  deleteReadAction?: typeof deleteQqEmailReadAction;
  createMarkdownAsset?: typeof createQqMarkdownAsset;
  removeMarkdownAsset?: typeof removeQqMarkdownAsset;
  onStatus?: (status: QqBotPublicStatus) => void;
  onBindingReady?: () => void;
};

function maskRecipient(userOpenId: string) {
  if (userOpenId.length <= 8) return "****";
  return `${userOpenId.slice(0, 4)}...${userOpenId.slice(-4)}`;
}

function validChallenge(challenge: QqBindingChallenge | undefined) {
  if (!challenge || challenge.consumedAt || Date.parse(challenge.expiresAt) <= Date.now()) return undefined;
  return { expiresAt: challenge.expiresAt };
}

function qqSendMayHaveSucceeded(error: unknown) {
  return error instanceof QqApiError && error.kind === "transient";
}

function defaultDependencies() {
  const tokenProvider = createTokenProvider();
  const client = createQqClient({ tokenProvider });
  return {
    gateway: createQqGateway({ tokenProvider }),
    client,
    bindingService: createQqBindingService({ client })
  };
}

export class QqManager {
  private readonly readConfig: () => QqBotConfig;
  private readonly gateway: QqManagerGateway;
  private readonly bindingService: QqManagerBindingService;
  private readonly quoteReadService: QqManagerQuoteReadService;
  private readonly buttonReadService: QqManagerButtonReadService;
  private readonly client: QqManagerClient;
  private readonly recordMessageReference: typeof recordQqNotificationReference;
  private readonly createReadAction: typeof createQqEmailReadAction;
  private readonly finalizeReadAction: typeof finalizeQqEmailReadAction;
  private readonly deleteReadAction: typeof deleteQqEmailReadAction;
  private readonly createMarkdownAsset: typeof createQqMarkdownAsset;
  private readonly removeMarkdownAsset: typeof removeQqMarkdownAsset;
  private readonly onStatusChange?: (status: QqBotPublicStatus) => void;
  private readonly onBindingReady?: () => void;
  private started = false;
  private stopped = false;
  private unsubscribeDispatch?: () => void;

  constructor(dependencies: QqManagerDependencies = {}) {
    const defaults = defaultDependencies();
    this.readConfig = dependencies.readConfig ?? readQqBotConfig;
    this.gateway = dependencies.gateway ?? defaults.gateway;
    this.bindingService = dependencies.bindingService ?? defaults.bindingService;
    this.client = dependencies.client ?? defaults.client;
    this.quoteReadService = dependencies.quoteReadService ?? createQqQuoteReadService({
      readConfig: this.readConfig,
      readBinding: () => this.bindingService.readBinding(),
      client: this.client
    });
    this.buttonReadService = dependencies.buttonReadService ?? createQqButtonReadService({
      readBinding: () => this.bindingService.readBinding(),
      client: this.client
    });
    this.recordMessageReference = dependencies.recordMessageReference ?? recordQqNotificationReference;
    this.createReadAction = dependencies.createReadAction ?? createQqEmailReadAction;
    this.finalizeReadAction = dependencies.finalizeReadAction ?? finalizeQqEmailReadAction;
    this.deleteReadAction = dependencies.deleteReadAction ?? deleteQqEmailReadAction;
    this.createMarkdownAsset = dependencies.createMarkdownAsset ?? createQqMarkdownAsset;
    this.removeMarkdownAsset = dependencies.removeMarkdownAsset ?? removeQqMarkdownAsset;
    this.onStatusChange = dependencies.onStatus;
    this.onBindingReady = dependencies.onBindingReady;
  }

  async start() {
    if (this.started) return;
    const config = this.readConfig();
    if (!config.enabled || !this.isConfigured(config)) {
      this.publishStatus();
      return;
    }

    this.started = true;
    this.stopped = false;
    this.unsubscribeDispatch = this.gateway.onDispatch((event) => {
      void this.handleDispatch(event);
    });
    try {
      await this.gateway.start();
    } catch (error) {
      this.started = false;
      this.unsubscribeDispatch?.();
      this.unsubscribeDispatch = undefined;
      this.publishStatus();
      throw error;
    }
    this.publishStatus();
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.started = false;
    this.unsubscribeDispatch?.();
    this.unsubscribeDispatch = undefined;
    await this.gateway.stop();
    this.publishStatus();
  }

  async rebind() {
    await this.start();
    const config = this.readConfig();
    if (!config.enabled || !this.isConfigured(config)) throw new Error("QQ bot is not enabled and configured");
    const challenge = this.bindingService.createBindingCode();
    this.publishStatus();
    return challenge;
  }

  async sendNotification(content: string) {
    const binding = this.bindingService.readBinding();
    if (!binding) throw new Error("QQ notification recipient is not bound");
    return this.client.sendDirectMessage({
      userOpenId: binding.userOpenId,
      content
    });
  }

  async sendImageNotification(image: Buffer, emailId?: string) {
    const binding = this.bindingService.readBinding();
    if (!binding) throw new Error("QQ notification recipient is not bound");

    let action = emailId ? this.createReadAction({ emailId, userOpenId: binding.userOpenId }) : undefined;
    let markdownAsset: ReturnType<typeof createQqMarkdownAsset> | undefined;
    let result: QqSendResult | undefined;

    if (action) {
      try {
        markdownAsset = this.createMarkdownAsset(image);
        result = await this.client.sendDirectMarkdownImage({
          userOpenId: binding.userOpenId,
          imageUrl: markdownAsset.url,
          readActionToken: action.token
        });
      } catch (error) {
        const retainAction = qqSendMayHaveSucceeded(error);
        if (!retainAction) {
          if (markdownAsset) this.removeMarkdownAsset(markdownAsset.token);
          this.deleteReadAction(action.token);
          action = undefined;
        }
        const reason = error instanceof Error ? error.message : String(error);
        const mapping = retainAction ? "; retained read action because delivery is uncertain" : "";
        console.warn(`QQ Markdown image notification unavailable; using media fallback${mapping}: ${reason.slice(0, 180)}`);
      }
    }

    if (!result) {
      result = await this.client.sendDirectImage({
        userOpenId: binding.userOpenId,
        image,
        fileName: "mail-summary.png"
      });
    }

    if (action) {
      try {
        this.finalizeReadAction(action.token, {
          messageId: result.messageId,
          refIndex: result.refIndex
        });
      } catch {
        // The notification is delivered; action mapping failure must not trigger a duplicate retry.
      }
    }
    if (emailId && (result.messageId || result.refIndex)) {
      try {
        this.recordMessageReference({
          emailId,
          userOpenId: binding.userOpenId,
          messageId: result.messageId,
          refIndex: result.refIndex
        });
      } catch {
        // The notification is delivered; quote mapping failure must not trigger a duplicate retry.
      }
    }
    return result;
  }

  async testNotification() {
    const result = await this.sendNotification("自动邮件系统 QQ 通知测试成功。");
    this.publishStatus();
    return result;
  }

  status(): QqBotPublicStatus {
    const config = this.readConfig();
    const binding = this.bindingService.readBinding();
    const challenge = validChallenge(this.bindingService.readChallenge());
    return {
      enabled: config.enabled,
      configured: this.isConfigured(config),
      gateway: this.gateway.status(),
      bound: Boolean(binding),
      ...(binding ? this.publicBinding(binding) : {}),
      ...(challenge ? { bindingChallenge: challenge } : {})
    };
  }

  private async handleDispatch(event: QqDispatchEvent) {
    try {
      const result = await this.bindingService.handleDispatchEvent(event);
      if (result.kind === "bound" || result.kind === "capability") this.onBindingReady?.();
      if (result.kind !== "duplicate") {
        const buttonResult = await this.buttonReadService.handleDispatchEvent(event);
        if (buttonResult.kind !== "ignored") {
          const details = "emailId" in buttonResult ? ` email=${buttonResult.emailId}` : "";
          const confirmation = "confirmationFailed" in buttonResult && buttonResult.confirmationFailed
            ? " confirmation=failed"
            : "";
          console.info(`[qq] mail-read interaction: ${buttonResult.kind}${details}${confirmation}`);
        }
        await this.quoteReadService.handleDispatchEvent(event);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[qq] dispatch handler failed for ${event.type}: ${message.slice(0, 180)}`);
    } finally {
      this.publishStatus();
    }
  }

  private isConfigured(config: QqBotConfig) {
    return Boolean(config.appId.trim() && config.encryptedAppSecret);
  }

  private publicBinding(binding: QqBotBinding) {
    return {
      maskedRecipient: maskRecipient(binding.userOpenId),
      friendshipStatus: binding.friendshipStatus,
      proactiveStatus: binding.proactiveStatus,
      boundAt: binding.createdAt,
      ...(binding.lastError ? { lastError: binding.lastError } : {})
    };
  }

  private publishStatus() {
    if (!this.onStatusChange) return;
    try {
      this.onStatusChange(this.status());
    } catch {
      // Status observers do not own the QQ lifecycle.
    }
  }
}

let manager: QqManager | undefined;

export function getQqManager() {
  manager ??= new QqManager({
    onStatus: (status) => publishAppEvent("qq-status", status),
    onBindingReady: () => {
      resumePausedNotificationDeliveries("qq");
      void import("../notifications/dispatcher").then(({ scheduleNotificationDispatch }) => {
        scheduleNotificationDispatch(0);
      });
      publishAppEvent("qq-binding", { bound: true });
    }
  });
  return manager;
}

export function getQqManagerStatus() {
  return getQqManager().status();
}

export function startQqManager() {
  return getQqManager().start();
}

export function stopQqManager() {
  return getQqManager().stop();
}

export async function restartQqManager() {
  const current = manager;
  manager = undefined;
  if (current) await current.stop();
  return startQqManager();
}

export function createQqRebindChallenge() {
  return getQqManager().rebind();
}

export function sendQqTestNotification() {
  return getQqManager().testNotification();
}
