import type { AiProtocol, AiSettings, MultimodalProtocol } from "./types";

export type AiProtocolMode = "text" | "multimodal";

type ProtocolSettings = Pick<AiSettings, "baseUrl"> &
  Partial<
    Pick<
      AiSettings,
      "model" | "protocol" | "multimodalBaseUrl" | "multimodalModel" | "multimodalProtocol"
    >
  >;

function splitUrlSuffix(baseUrl: string) {
  const trimmed = baseUrl.trim();
  const queryIndex = trimmed.search(/[?#]/);
  const path = queryIndex === -1 ? trimmed : trimmed.slice(0, queryIndex);
  const suffix = queryIndex === -1 ? "" : trimmed.slice(queryIndex);
  return { path: path.replace(/\/+$/, ""), suffix };
}

function appendPath(baseUrl: string, endpoint: string, completeEndpoint: RegExp) {
  const { path, suffix } = splitUrlSuffix(baseUrl);
  if (completeEndpoint.test(path)) return `${path}${suffix}`;
  return `${path}/${endpoint}${suffix}`;
}

function inferAiProtocol(baseUrl: string): AiProtocol {
  const { path } = splitUrlSuffix(baseUrl);
  if (/\/anthropic(?:\/|$)/i.test(path) || /\/v1\/messages(?:\/|$)/i.test(path)) {
    return "anthropic";
  }
  if (/generativelanguage\.googleapis\.com/i.test(path) || /:generateContent(?:\/|$)/i.test(path)) {
    return "gemini";
  }
  if (/\/responses(?:\/|$)/i.test(path)) return "openai-responses";
  return "openai-chat";
}

function configuredProtocol(settings: ProtocolSettings, mode: AiProtocolMode): AiProtocol | MultimodalProtocol | undefined {
  return mode === "multimodal" ? settings.multimodalProtocol : settings.protocol;
}

function baseUrlForMode(settings: ProtocolSettings, mode: AiProtocolMode) {
  return mode === "multimodal" ? settings.multimodalBaseUrl || settings.baseUrl : settings.baseUrl;
}

function modelForMode(settings: ProtocolSettings, mode: AiProtocolMode) {
  return mode === "multimodal"
    ? settings.multimodalModel || settings.model || ""
    : settings.model || "";
}

export function resolveAiProtocol(settings: ProtocolSettings, mode: AiProtocolMode): AiProtocol {
  const configured = configuredProtocol(settings, mode);
  if (mode === "multimodal" && configured === "same") {
    return resolveAiProtocol(settings, "text");
  }
  if (configured && configured !== "auto" && configured !== "same") return configured;
  return inferAiProtocol(baseUrlForMode(settings, mode));
}

export function resolveOpenAiChatUrl(baseUrl: string) {
  return appendPath(baseUrl, "chat/completions", /\/chat\/completions$/i);
}

export function resolveOpenAiResponsesUrl(baseUrl: string) {
  return appendPath(baseUrl, "responses", /\/responses$/i);
}

export function resolveAnthropicMessagesUrl(baseUrl: string) {
  const { path, suffix } = splitUrlSuffix(baseUrl);
  if (/\/v1\/messages$/i.test(path)) return `${path}${suffix}`;
  if (/\/v1$/i.test(path)) return `${path}/messages${suffix}`;
  return `${path}/v1/messages${suffix}`;
}

export function resolveGeminiGenerateContentUrl(baseUrl: string, model: string) {
  const { path, suffix } = splitUrlSuffix(baseUrl);
  if (/:generateContent$/i.test(path)) return `${path}${suffix}`;
  if (/\/models\/[^/]+$/i.test(path)) return `${path}:generateContent${suffix}`;
  return `${path}/models/${encodeURIComponent(model.trim())}:generateContent${suffix}`;
}

export function resolveAiEndpoint(settings: ProtocolSettings, mode: AiProtocolMode) {
  const baseUrl = baseUrlForMode(settings, mode);
  switch (resolveAiProtocol(settings, mode)) {
    case "openai-responses":
      return resolveOpenAiResponsesUrl(baseUrl);
    case "anthropic":
      return resolveAnthropicMessagesUrl(baseUrl);
    case "gemini":
      return resolveGeminiGenerateContentUrl(baseUrl, modelForMode(settings, mode));
    case "auto":
    case "openai-chat":
      return resolveOpenAiChatUrl(baseUrl);
  }
}
