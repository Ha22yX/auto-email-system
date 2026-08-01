export { resolveOpenAiChatUrl } from "./ai-protocol";

function usesDefaultTemperature(model: string) {
  const normalized = model.trim();
  return (
    /^gpt-5\.6(?:[-.]|$)/i.test(normalized) ||
    /^claude-(?:sonnet|opus|haiku)-5(?:[-.]|$)/i.test(normalized)
  );
}

export function buildTemperaturePayload(model: string, temperature: number) {
  return usesDefaultTemperature(model) ? {} : { temperature };
}
