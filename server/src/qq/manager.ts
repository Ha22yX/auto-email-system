import { publishAppEvent } from "../events";
import {
  readQqBotConfig,
  recordQqNotificationReference,
  resumePausedNotificationDeliveries
} from "../store";
import type { QqBotBinding, QqBotConfig } from "../types";
import { createQqAgentService, type QqAgentService } from "./agent";
import { createQqBindingService, type QqBindingChallenge, type QqBindingService } from "./binding";
import { createQqButtonReadService, type QqButtonReadService } from "./button-read";
import { createQqClient } from "./client";
import { createTokenProvider } from "./credentials";
import { createQqGateway } from "./gateway";
import { createQqQuoteReadService, type QqQuoteReadService } from "./quote-read";
import type {
  QqBotPublicStatus,
  QqDirectImageInput,
  QqDirectMarkdownMessageInput,
  QqDirectMessageInput,
  QqDispatchEvent,
  QqGatewayStatus,
  QqSendResult
} from "./types";

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
type QqManagerAgentService = Pick<QqAgentService, "handleDispatchEvent">;

type QqManagerClient = {
  sendDirectMessage(input: QqDirectMessageInput): Promise<QqSendResult>;
  sendDirectMarkdownMessage?(input: QqDirectMarkdownMessageInput): Promise<QqSendResult>;
  sendDirectImage(input: QqDirectImageInput): Promise<QqSendResult>;
  acknowledgeInteraction(interactionId: string): Promise<void>;
};

export type QqManagerDependencies = {
  readConfig?: () => QqBotConfig;
  gateway?: QqManagerGateway;
  bindingService?: QqManagerBindingService;
  quoteReadService?: QqManagerQuoteReadService;
  buttonReadService?: QqManagerButtonReadService;
  agentService?: QqManagerAgentService;
  client?: QqManagerClient;
  recordMessageReference?: typeof recordQqNotificationReference;
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
  private readonly agentService: QqManagerAgentService;
  private readonly client: QqManagerClient;
  private readonly recordMessageReference: typeof recordQqNotificationReference;
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
    this.agentService = dependencies.agentService ?? createQqAgentService({
      readConfig: this.readConfig,
      readBinding: () => this.bindingService.readBinding(),
      client: this.client
    });
    this.recordMessageReference = dependencies.recordMessageReference ?? recordQqNotificationReference;
    this.onStatusChange = dependencies.onStatus;
    this.onBindingReady = dependencies.onBindingReady;
  }

  async start() {
    if (this.started) return;
    const config = this.readConfig();
    if (!this.shouldRun(config) || !this.isConfigured(config)) {
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
    if (!this.shouldRun(config) || !this.isConfigured(config)) throw new Error("QQ bot is not enabled and configured");
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

    const result = await this.client.sendDirectImage({
      userOpenId: binding.userOpenId,
      image,
      fileName: "mail-summary.png"
    });
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
        const quoteResult = await this.quoteReadService.handleDispatchEvent(event);
        if (quoteResult.kind !== "ignored" && quoteResult.kind !== "disabled") {
          const details = "emailId" in quoteResult ? ` email=${quoteResult.emailId}` : "";
          const confirmation = "confirmationFailed" in quoteResult && quoteResult.confirmationFailed
            ? " confirmation=failed"
            : "";
          console.info(`[qq] mail-quote interaction: ${quoteResult.kind}${details}${confirmation}`);
        }
        if (
          result.kind !== "bound" &&
          buttonResult.kind === "ignored" &&
          (quoteResult.kind === "ignored" || quoteResult.kind === "disabled")
        ) {
          const agentResult = await this.agentService.handleDispatchEvent(event);
          if (agentResult.kind !== "ignored" && agentResult.kind !== "disabled") {
            console.info(`[qq] agent interaction: ${agentResult.kind}`);
          }
        }
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

  private shouldRun(config: QqBotConfig) {
    return Boolean(config.enabled || config.agent?.enabled);
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
