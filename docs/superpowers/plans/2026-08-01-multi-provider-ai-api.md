# Multi-provider AI API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the provider-branded AI settings with a protocol-aware configuration and support OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, and Google Gemini for text and multimodal email analysis.

**Architecture:** Add a small protocol adapter module that owns protocol inference, endpoint resolution, request serialization, and response extraction. Keep `classifyEmail` and `analyzeEmailAttachments` as the processor-facing services, with saved settings normalized for backward compatibility and a separate preset module shared by the React form.

**Tech Stack:** TypeScript, Node.js 24, Express, Zod, React 19, Node test runner, Vite.

## Global Constraints

- Existing SQLite settings, API keys, mailboxes, and processed emails must remain intact.
- The source email is only marked read after successful classification and persistence.
- API keys must never appear in public settings responses, logs, or provider error messages.
- Existing GLM Anthropic and OpenAI-compatible configurations must continue working through `auto` protocol detection.
- The UI must retain the existing compact admin-panel visual language and responsive grid.

---

### Task 1: Protocol types, inference, and endpoint resolution

**Files:**
- Modify: `server/src/types.ts`
- Modify: `src/types.ts`
- Create: `server/src/ai-protocol.ts`
- Create: `server/src/ai-protocol.test.ts`
- Modify: `server/src/ai-request.ts`

**Interfaces:**
- Produces: `AiProtocol`, `MultimodalProtocol`, `resolveAiProtocol(settings, mode)`, and provider endpoint resolvers.
- Consumes: existing `AiSettings`, Base URLs, and model names.

- [ ] Write failing tests for Anthropic URL inference, Gemini URL inference, OpenAI fallback, complete endpoint preservation, and GPT-5.6 temperature omission.
- [ ] Run `node --test --import tsx server/src/ai-protocol.test.ts` and confirm failures identify missing protocol APIs.
- [ ] Add protocol fields to server/client `AiSettings` and implement pure inference and URL helpers.
- [ ] Run the protocol tests and confirm they pass.

### Task 2: Provider request adapters

**Files:**
- Create: `server/src/ai-adapters.ts`
- Create: `server/src/ai-adapters.test.ts`
- Modify: `server/src/ai.ts`
- Modify: `server/src/multimodal.ts`

**Interfaces:**
- Consumes: normalized protocol, endpoint, API key, system/user prompts, and attachment data.
- Produces: `buildTextRequest`, `buildMultimodalRequest`, and `extractProviderText` used by both AI services.

- [ ] Write failing tests asserting auth headers and JSON bodies for OpenAI Chat, Responses, Anthropic, and Gemini.
- [ ] Add response fixtures and failing tests for extracting text from all four response shapes.
- [ ] Run `node --test --import tsx server/src/ai-adapters.test.ts` and verify the intended failures.
- [ ] Implement the adapter builders with protocol-specific content blocks and secret-safe errors.
- [ ] Replace provider branches in `ai.ts` and the OpenAI-only multimodal request in `multimodal.ts` with adapter calls.
- [ ] Run adapter and existing AI request tests and confirm all pass.

### Task 3: Backward-compatible settings persistence

**Files:**
- Modify: `server/src/store.ts`
- Modify: `server/src/routes.ts`
- Create: `server/src/ai-settings.test.ts`

**Interfaces:**
- Consumes: legacy settings rows and incoming settings payloads.
- Produces: normalized saved settings with masked primary and multimodal secrets.

- [ ] Write failing tests for legacy defaults, protocol normalization, inherited multimodal keys, and preserving both saved keys when submitted fields are empty.
- [ ] Extend the Zod schema with `providerPreset`, `protocol`, `multimodalProtocol`, and `multimodalApiKey`.
- [ ] Normalize settings on every SQLite read, update settings without replacing blank secrets, and mask both keys in public responses.
- [ ] Run the settings tests and confirm migration and secret-preservation behavior.

### Task 4: Provider presets and AI settings UI

**Files:**
- Create: `src/ai-presets.ts`
- Create: `src/ai-presets.test.ts`
- Modify: `src/App.tsx`
- Modify: `src/styles.css`
- Modify: `src/api.ts`

**Interfaces:**
- Produces: `AI_PROVIDER_PRESETS` and `applyAiPreset(current, presetId)`.
- Consumes: public `AiSettings` and existing save/test methods.

- [ ] Write failing tests showing presets fill endpoints, protocols, and models without replacing API keys.
- [ ] Implement presets for OpenAI, Anthropic, Gemini, Zhipu, DeepSeek, Qwen, Moonshot, OpenRouter, and Custom.
- [ ] Rename the card to `AI API Settings` and add provider/protocol controls for primary and multimodal models.
- [ ] Add an optional multimodal API key field with inherited-key copy and responsive grouping.
- [ ] Update test-result typing so the UI can show resolved protocol, endpoint host, model, and category.
- [ ] Run preset tests and `npm run build`.

### Task 5: Test endpoint diagnostics and regression verification

**Files:**
- Modify: `server/src/routes.ts`
- Modify: `src/api.ts`
- Modify: `src/App.tsx`

**Interfaces:**
- Produces: `{ ok, message, protocol, endpoint, model, category }` from `/api/settings/ai/test`.

- [ ] Add route-level assertions for resolved protocol metadata without exposing query keys.
- [ ] Return protocol diagnostics from the test route and render a concise success message.
- [ ] Run all Node tests: `node --test --import tsx server/src/*.test.ts server/src/weclaw/manager.test.ts src/*.test.ts`.
- [ ] Run `npm run build` and `git diff --check`.

### Task 6: Commit, push, and deploy

**Files:**
- Verify: all modified files and generated `dist` output without committing `dist` unless already tracked.

**Interfaces:**
- Produces: a GitHub `main` commit and a healthy Baota-managed production service.

- [ ] Review `git diff` for secrets and unrelated changes.
- [ ] Commit implementation with `git commit -m "Add multi-provider AI API settings"`.
- [ ] Push `main` to GitHub.
- [ ] Pull on `/www/wwwroot/auto-email-system/current`, run tests/build, and restart with the existing Baota script.
- [ ] Verify `http://127.0.0.1:8787/api/health` returns `ok: true` and `https://mail.rosebeg.com/` returns HTTP 200.
