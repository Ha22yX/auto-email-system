# Multi-provider AI API settings design

## Goal

Replace the provider-specific "智谱 GLM Coding Plan" settings surface with a general "AI API Settings" system. The system must support common native and compatible APIs for both email classification and multimodal attachment analysis without invalidating existing saved settings or API keys.

## Supported protocols

The first release supports these request protocols:

- `auto`: infer the protocol from the Base URL while preserving the current behavior.
- `openai-chat`: OpenAI Chat Completions and compatible services.
- `openai-responses`: OpenAI Responses API.
- `anthropic`: Anthropic Messages and compatible services such as the GLM Coding Plan Anthropic endpoint.
- `gemini`: Google Gemini `generateContent`.

Provider presets configure sensible protocol, endpoint, model, and display-name defaults for OpenAI, Anthropic Claude, Google Gemini, Zhipu GLM, DeepSeek, Qwen, Moonshot, OpenRouter, and Custom. A preset only updates visible configuration fields; the saved configuration remains editable.

## Settings model

`AiSettings` gains the following backward-compatible fields:

- `providerPreset`: selected UI preset identifier.
- `protocol`: text-classification protocol.
- `multimodalProtocol`: attachment-analysis protocol or `same`.
- `multimodalApiKey`: optional dedicated key; an empty value inherits the primary API key.

Existing fields remain supported. Missing new fields are normalized to `custom`, `auto`, `same`, and an empty inherited multimodal key. Existing primary and multimodal endpoints, models, and encrypted-at-rest behavior are preserved. Public API responses mask both keys.

## Adapter architecture

Request construction and response parsing move behind a protocol adapter interface. Each adapter receives normalized settings and semantic content, and is responsible for:

- resolving a root URL or accepting a complete endpoint URL;
- applying the correct authentication headers;
- creating text-only classification requests;
- creating image/PDF multimodal requests;
- requesting JSON output where the protocol supports it;
- extracting returned text into the existing JSON normalization pipeline;
- omitting unsupported parameters such as custom GPT-5.6 temperature values.

The email processor continues to call `classifyEmail` and `analyzeEmailAttachments`. It does not need provider-specific branches and retains the existing ordering: analyze attachments, classify, persist the email, mark the source message read, then send notifications.

## Protocol mappings

### OpenAI Chat Completions

Root URLs are completed with `/chat/completions`. Text uses system and user messages with JSON response format. Images use data URLs. PDF inputs use supported file content where available; unsupported input errors remain attached to the processing run without marking the source email read.

### OpenAI Responses

Root URLs are completed with `/responses`. Instructions and input content are translated to Responses items. Returned `output_text` or text output blocks feed the existing JSON parser.

### Anthropic Messages

Root URLs are completed with `/v1/messages`. Authentication uses `x-api-key` and `anthropic-version`. Images and PDFs are represented as base64 source blocks. Text output is collected from content blocks.

### Google Gemini

Root URLs are completed with `/models/{model}:generateContent`. Authentication uses `x-goog-api-key`. Text, images, and PDFs become Gemini parts with `inlineData`. JSON output is requested through `generationConfig.responseMimeType`.

## User interface

The card title becomes `AI API Settings`. The layout remains consistent with the current quiet administrative UI:

- A compact provider preset selector appears first.
- Protocol, Base URL, model, and temperature are grouped as the primary model.
- Multimodal settings form a collapsible secondary group with protocol, endpoint, model, optional separate key, and size limits.
- Selecting a preset fills recommended values but never overwrites a non-empty API key.
- `auto` and `same as primary` remain the default migration-safe choices.
- The test result reports provider, resolved protocol, model, and successful classification. Protocol-specific failures are translated into concise Chinese guidance.

## Error handling and safety

- Unknown auto-detection results fall back to OpenAI Chat Completions for compatibility.
- URL resolution never duplicates known endpoint suffixes.
- API keys are never returned unmasked and never included in logs or error messages.
- Invalid provider responses fail before database insertion and before the source email is marked read.
- A dedicated multimodal key is preserved when the settings form submits an empty masked field.
- Existing request timeouts remain in place.

## Testing

Automated tests cover protocol inference, endpoint resolution, provider-specific request bodies, temperature omission, response extraction, preset application, settings migration, and secret preservation. The existing email-processing tests, TypeScript build, and production health checks remain required before deployment.

## Deployment

The change is committed to `main`, pushed to GitHub, pulled by the existing Baota-managed project, built on the server, and restarted through the current Baota start script. SQLite data and saved settings remain in place.
