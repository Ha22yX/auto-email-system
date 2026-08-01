import { buildTemperaturePayload } from "./ai-request";
import type { AiProtocol } from "./types";

type JsonPart = Record<string, unknown>;

export type ProviderAttachment = {
  filename: string;
  contentType: string;
  contentBase64: string;
};

export type ProviderRequestInput = {
  protocol: AiProtocol;
  url: string;
  apiKey: string;
  model: string;
  temperature: number;
  systemPrompt: string;
  userPrompt: string;
  attachments?: ProviderAttachment[];
};

function attachmentDataUrl(attachment: ProviderAttachment) {
  return `data:${attachment.contentType};base64,${attachment.contentBase64}`;
}

function isImage(attachment: ProviderAttachment) {
  return /^image\//i.test(attachment.contentType);
}

function isPdf(attachment: ProviderAttachment) {
  return /^application\/pdf$/i.test(attachment.contentType);
}

function openAiChatContent(input: ProviderRequestInput) {
  const attachments = input.attachments ?? [];
  if (!attachments.length) return input.userPrompt;

  return [
    ...attachments.flatMap<JsonPart>((attachment) => {
      if (isImage(attachment)) {
        return [{ type: "image_url", image_url: { url: attachmentDataUrl(attachment) } }];
      }
      if (isPdf(attachment)) {
        return [
          {
            type: "file",
            file: {
              filename: attachment.filename,
              file_data: attachmentDataUrl(attachment)
            }
          }
        ];
      }
      return [];
    }),
    { type: "text", text: input.userPrompt }
  ];
}

function openAiResponsesContent(input: ProviderRequestInput) {
  return [
    { type: "input_text", text: input.userPrompt },
    ...(input.attachments ?? []).flatMap<JsonPart>((attachment) => {
      if (isImage(attachment)) {
        return [{ type: "input_image", image_url: attachmentDataUrl(attachment) }];
      }
      if (isPdf(attachment)) {
        return [
          {
            type: "input_file",
            filename: attachment.filename,
            file_data: attachmentDataUrl(attachment)
          }
        ];
      }
      return [];
    })
  ];
}

function anthropicContent(input: ProviderRequestInput) {
  return [
    { type: "text", text: input.userPrompt },
    ...(input.attachments ?? []).flatMap<JsonPart>((attachment) => {
      if (isImage(attachment)) {
        return [
          {
            type: "image",
            source: { type: "base64", media_type: attachment.contentType, data: attachment.contentBase64 }
          }
        ];
      }
      if (isPdf(attachment)) {
        return [
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: attachment.contentBase64 }
          }
        ];
      }
      return [];
    })
  ];
}

function geminiParts(input: ProviderRequestInput) {
  return [
    { text: input.userPrompt },
    ...(input.attachments ?? []).flatMap<JsonPart>((attachment) => {
      if (!isImage(attachment) && !isPdf(attachment)) return [];
      return [
        {
          inline_data: {
            mime_type: attachment.contentType,
            data: attachment.contentBase64
          }
        }
      ];
    })
  ];
}

function jsonInit(headers: Record<string, string>, body: unknown): RequestInit {
  return {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  };
}

export function buildProviderRequest(input: ProviderRequestInput): { url: string; init: RequestInit } {
  const temperature = buildTemperaturePayload(input.model, input.temperature);

  switch (input.protocol) {
    case "openai-chat":
      return {
        url: input.url,
        init: jsonInit(
          { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json" },
          {
            model: input.model,
            ...temperature,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: input.systemPrompt },
              { role: "user", content: openAiChatContent(input) }
            ]
          }
        )
      };
    case "openai-responses":
      return {
        url: input.url,
        init: jsonInit(
          { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json" },
          {
            model: input.model,
            ...temperature,
            instructions: input.systemPrompt,
            text: { format: { type: "json_object" } },
            input: [{ role: "user", content: openAiResponsesContent(input) }]
          }
        )
      };
    case "anthropic":
      return {
        url: input.url,
        init: jsonInit(
          {
            "x-api-key": input.apiKey,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json"
          },
          {
            model: input.model,
            max_tokens: 1200,
            ...temperature,
            system: input.systemPrompt,
            messages: [{ role: "user", content: anthropicContent(input) }]
          }
        )
      };
    case "gemini":
      return {
        url: input.url,
        init: jsonInit(
          { "x-goog-api-key": input.apiKey, "Content-Type": "application/json" },
          {
            generationConfig: { responseMimeType: "application/json", ...temperature },
            systemInstruction: { parts: [{ text: input.systemPrompt }] },
            contents: [{ role: "user", parts: geminiParts(input) }]
          }
        )
      };
    case "auto":
      throw new Error("AI protocol has not been resolved.");
  }
}

function textParts(value: unknown) {
  return Array.isArray(value)
    ? value
        .map((part) => {
          if (!part || typeof part !== "object") return "";
          const item = part as Record<string, unknown>;
          return typeof item.text === "string"
            ? item.text
            : typeof item.output_text === "string"
              ? item.output_text
              : "";
        })
        .filter(Boolean)
        .join("\n")
    : "";
}

export function extractProviderText(protocol: AiProtocol, payload: unknown): string {
  const item = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};

  switch (protocol) {
    case "openai-chat": {
      const choices = Array.isArray(item.choices) ? item.choices : [];
      const message = choices[0] && typeof choices[0] === "object"
        ? (choices[0] as { message?: { content?: unknown } }).message
        : undefined;
      return typeof message?.content === "string" ? message.content : textParts(message?.content);
    }
    case "openai-responses": {
      if (typeof item.output_text === "string" && item.output_text) return item.output_text;
      const output = Array.isArray(item.output) ? item.output : [];
      return output
        .flatMap((entry) => {
          if (!entry || typeof entry !== "object") return [];
          return textParts((entry as { content?: unknown }).content).split("\n").filter(Boolean);
        })
        .join("\n");
    }
    case "anthropic":
      return Array.isArray(item.content)
        ? item.content
            .filter((block): block is { type?: unknown; text?: unknown } => Boolean(block && typeof block === "object"))
            .filter((block) => block.type === "text" && typeof block.text === "string")
            .map((block) => block.text as string)
            .join("\n")
        : "";
    case "gemini":
      return Array.isArray(item.candidates)
        ? item.candidates
            .flatMap((candidate) => {
              if (!candidate || typeof candidate !== "object") return [];
              const content = (candidate as { content?: { parts?: unknown } }).content;
              return textParts(content?.parts).split("\n").filter(Boolean);
            })
            .join("\n")
        : "";
    case "auto":
      return "";
  }
}
