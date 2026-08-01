export function resolveOpenAiChatUrl(baseUrl: string) {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(normalized)) return normalized;
  return `${normalized}/chat/completions`;
}

function usesDefaultTemperature(model: string) {
  return /^gpt-5\.6(?:[-.]|$)/i.test(model.trim());
}

export function buildTemperaturePayload(model: string, temperature: number) {
  return usesDefaultTemperature(model) ? {} : { temperature };
}
