import { extractProviderUsage } from "./ai-adapters";
import { recordAiUsageEvent } from "./store";
import type { AiProtocol, AiUsagePurpose, AiUsageScope } from "./types";

type TrackedAiRequestInput = {
  scope: AiUsageScope;
  purpose: AiUsagePurpose;
  provider: string;
  protocol: AiProtocol;
  model: string;
  apiKey: string;
  errorLabel: string;
  detailLimit?: number;
  request: () => Promise<Response>;
};

function safeError(error: unknown, apiKey: string) {
  const message = error instanceof Error ? error.message : String(error);
  return apiKey ? message.replaceAll(apiKey, "[REDACTED]") : message;
}

function safelyRecordUsage(input: Parameters<typeof recordAiUsageEvent>[0]) {
  try {
    recordAiUsageEvent(input);
  } catch (error) {
    console.error("[ai-usage] Failed to persist usage metadata:", error);
  }
}

export async function executeTrackedAiRequest(input: TrackedAiRequestInput) {
  const startedAt = new Date();
  const startedMs = Date.now();
  let recorded = false;

  try {
    const response = await input.request();
    if (!response.ok) {
      const detail = safeError(await response.text(), input.apiKey);
      const error = new Error(`${input.errorLabel} ${response.status}: ${detail.slice(0, input.detailLimit ?? 300)}`);
      safelyRecordUsage({
        scope: input.scope,
        purpose: input.purpose,
        provider: input.provider,
        protocol: input.protocol,
        model: input.model,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        usageReported: false,
        success: false,
        latencyMs: Date.now() - startedMs,
        error: safeError(error, input.apiKey),
        occurredAt: startedAt.toISOString()
      });
      recorded = true;
      throw error;
    }

    const payload: unknown = await response.json();
    const usage = extractProviderUsage(input.protocol, payload);
    safelyRecordUsage({
      scope: input.scope,
      purpose: input.purpose,
      provider: input.provider,
      protocol: input.protocol,
      model: usage.responseModel || input.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      totalTokens: usage.totalTokens,
      usageReported: usage.usageReported,
      success: true,
      latencyMs: Date.now() - startedMs,
      requestId: usage.requestId,
      occurredAt: startedAt.toISOString()
    });
    recorded = true;
    return payload;
  } catch (error) {
    if (!recorded) {
      safelyRecordUsage({
        scope: input.scope,
        purpose: input.purpose,
        provider: input.provider,
        protocol: input.protocol,
        model: input.model,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        usageReported: false,
        success: false,
        latencyMs: Date.now() - startedMs,
        error: safeError(error, input.apiKey),
        occurredAt: startedAt.toISOString()
      });
    }
    throw error;
  }
}
