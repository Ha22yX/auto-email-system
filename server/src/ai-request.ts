export { resolveOpenAiChatUrl } from "./ai-protocol";

function usesDefaultTemperature(model: string) {
  const normalized = model.trim();
  return (
    /^gpt-5\.6(?:[-.]|$)/i.test(normalized) ||
    /^claude-[a-z0-9-]+-5(?:[-.]|$)/i.test(normalized) ||
    /^gemini-3\.5-flash-lite(?:[-.]|$)/i.test(normalized) ||
    /^gemini-(?:3\.(?:[6-9]|[1-9]\d)|[4-9]\d*\.\d+)(?:[-.]|$)/i.test(normalized)
  );
}

export function buildTemperaturePayload(model: string, temperature: number) {
  return usesDefaultTemperature(model) ? {} : { temperature };
}
