# Low-Memory Production Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the memory-heavy Node/npm supervision chain with a Bash supervisor and cap the application heap at 384 MB.

**Architecture:** Baota launches one Bash supervisor, which owns one Node application child and a lightweight `curl` health loop. The supervisor forwards signals, restarts failures with bounded backoff, and leaves all application behavior unchanged.

**Tech Stack:** Bash, Node.js 24, TypeScript, Node test runner, Baota Node Project Manager

## Global Constraints

- Production must remain manageable from Baota.
- Default Node old-space limit is 384 MB and remains configurable with `APP_MAX_OLD_SPACE_MB`.
- `MALLOC_ARENA_MAX` defaults to 2.
- Health checks use `/api/health`, three failures, and bounded restart backoff.
- Mail processing, database, IMAP, AI, and notification code are out of scope.

---

### Task 1: Low-memory supervisor

**Files:**
- Create: `scripts/service-supervisor.test.ts`
- Create: `scripts/service-supervisor.sh`
- Modify: `package.json`
- Delete: `scripts/service-supervisor.mjs`

**Interfaces:**
- Consumes: `APP_MAX_OLD_SPACE_MB`, `APP_HEALTH_URL`, `APP_HEALTH_INTERVAL_SECONDS`, and `APP_HEALTH_FAILURE_LIMIT` environment variables.
- Produces: one long-running Bash PID that owns and supervises one Node child.

- [ ] **Step 1: Write the failing regression test**

Add assertions that `npm start` invokes Bash, the script defaults to 384 MB and two malloc arenas, launches Node directly, performs health checks, forwards termination, and loops for restart.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --import tsx --test scripts/service-supervisor.test.ts`

Expected: FAIL because `package.json` still starts `service-supervisor.mjs` and the Bash script does not exist.

- [ ] **Step 3: Implement the Bash supervisor**

Create the supervisor with a child process loop, health monitor, signal traps, forced termination timeout, and bounded exponential backoff. Change `npm start` to `bash scripts/service-supervisor.sh` and remove the Node supervisor.

- [ ] **Step 4: Verify GREEN and run all checks**

Run: `node --import tsx --test scripts/service-supervisor.test.ts`

Run: `node --import tsx --test server/src/*.test.ts scripts/*.test.ts`

Run: `npm run build`

Expected: all tests pass and the build exits 0.

### Task 2: Baota deployment and measurement

**Files:**
- Modify on server: `/www/server/nodejs/vhost/scripts/auto_email_system.sh`
- Deploy repository to: `/www/wwwroot/auto-email-system/current`

**Interfaces:**
- Consumes: repository Bash supervisor.
- Produces: a Baota-managed production service whose PID is the Bash supervisor PID.

- [ ] **Step 1: Record the existing process tree and RSS**

Capture the Baota PID, descendants, commands, and RSS before changing the start script.

- [ ] **Step 2: Deploy and validate shell syntax**

Push the verified commit, update the server checkout, run `bash -n scripts/service-supervisor.sh`, and change the Baota start script to execute `/bin/bash scripts/service-supervisor.sh` directly.

- [ ] **Step 3: Restart through the Baota script**

Stop the existing PID tree cleanly, start it with the Baota script, and confirm the PID file points to Bash rather than npm or Node.

- [ ] **Step 4: Verify service health and reduced RSS**

Check `/api/health`, `https://mail.rosebeg.com/`, the process tree, and total service RSS. Terminate only the Node child once and verify Bash restarts it automatically.
