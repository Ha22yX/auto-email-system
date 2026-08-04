# WeClaw Token Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make WeChat token health truthful and deliver refresh reminders before the proactive-send window becomes unreliable.

**Architecture:** Extend the persisted context-token store with per-recipient metadata, derive a public health snapshot through a pure function, and make all direct sends record verification or terminal failure. The existing manager remains the integration boundary while the React panel consumes only sanitized status fields.

**Tech Stack:** TypeScript, Node.js, React, Node test runner, existing iLink bridge.

## Global Constraints

- Never expose context-token values or hashes through the API or UI.
- Preserve and migrate existing `context_tokens.json` data.
- Default nominal TTL remains 24 hours; default reminder lead becomes 4 hours.
- Failed email notifications remain queued and retry after a verified inbound context.

---

### Task 1: Token Health Model

**Files:**
- Modify: `server/src/weclaw/manager.ts`
- Test: `server/src/weclaw/manager.test.ts`

**Interfaces:**
- Produces: `deriveWeclawTokenHealth(input, now): WeclawTokenHealthSnapshot`
- Produces: persisted `token_meta[userId]` with capture, verification, and failure fields.

- [ ] **Step 1: Write failing boundary tests**

Add literal timestamp cases for `healthy`, `refresh-soon`, `expired`, `invalid`, and `unverified` snapshots. Assert `contextReady` only for healthy states.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test --import tsx server/src/weclaw/manager.test.ts`

Expected: FAIL because `deriveWeclawTokenHealth` does not exist.

- [ ] **Step 3: Implement the minimal pure health derivation and migration-safe metadata reader**

Use the current token hash only internally. Derive nominal expiry from `captured_at + 24h` and refresh threshold from `captured_at + 20h`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --test --import tsx server/src/weclaw/manager.test.ts`

Expected: PASS.

### Task 2: Verified Send Lifecycle

**Files:**
- Modify: `server/src/weclaw/manager.ts`
- Test: `server/src/weclaw/manager.test.ts`

**Interfaces:**
- Consumes: current token and `token_meta` record.
- Produces: verification metadata after successful direct sends and failure metadata after iLink rejections.

- [ ] **Step 1: Write failing state-transition tests**

Cover a same-token capture preserving a newer failure, a new-token capture clearing stale state, a successful send clearing failure, and a rejected send making the current token invalid.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test --import tsx server/src/weclaw/manager.test.ts`

Expected: FAIL on missing transitions.

- [ ] **Step 3: Implement state transitions around `sendWeclawDirectText` and refresh confirmation**

Record `verified_at` only after `ret=0`. Record sanitized `failed_at` and `last_error` on terminal iLink send rejection. Trigger pending email retry only after the context becomes verified.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --test --import tsx server/src/weclaw/manager.test.ts`

Expected: PASS.

### Task 3: Early Reminder and Public Status

**Files:**
- Modify: `server/src/weclaw/manager.ts`
- Modify: `src/types.ts`
- Modify: `src/App.tsx`
- Test: `server/src/weclaw/manager.test.ts`

**Interfaces:**
- Produces: sanitized `tokenHealth`, `contextCapturedAt`, `contextVerifiedAt`, `contextEstimatedExpiresAt`, and `contextLastError` status fields.

- [ ] **Step 1: Write the failing reminder-boundary test**

At 19h59m the reminder is not due; at 20h it is due for a 24-hour TTL and four-hour lead.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test --import tsx server/src/weclaw/manager.test.ts`

Expected: FAIL while the lead remains one hour.

- [ ] **Step 3: Implement four-hour lead, API status fields, and compact UI health copy**

Use `Intl.DateTimeFormat` for display and label expiry as estimated. Show terminal send failure prominently and tell the user to send a message to ClawBot.

- [ ] **Step 4: Verify focused and full suites**

Run: `node --test --import tsx server/src/*.test.ts server/src/weclaw/manager.test.ts src/*.test.ts`

Run: `npm.cmd run build`

Expected: all tests and production build pass.

### Task 4: Release

**Files:**
- No additional source files.

- [ ] **Step 1: Review diff and scan for credentials**

Run: `git diff --check` and inspect only sanitized metadata fields.

- [ ] **Step 2: Commit and push `main`**

Commit the implementation and push to `origin/main` after tests pass.

- [ ] **Step 3: Deploy through the existing Baota Node project**

Fast-forward the server checkout, build, restart the project-specific process tree, and verify `GET /api/health` plus `https://mail.rosebeg.com/` return HTTP 200.

