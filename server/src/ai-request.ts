export { resolveOpenAiChatUrl } from "./ai-protocol";

function usesDefaultTemperature(model: string) {
  return /^gpt-5\.6(?:[-.]|$)/i.test(model.trim());
}

export function buildTemperaturePayload(model: string, temperature: number) {
  return usesDefaultTemperature(model) ? {} : { temperature };
}
