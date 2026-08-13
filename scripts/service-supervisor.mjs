import { spawn } from "node:child_process";

const appRoot = process.cwd();
const maxOldSpaceMb = Math.max(256, Number(process.env.APP_MAX_OLD_SPACE_MB || 640));
const healthUrl = process.env.APP_HEALTH_URL || "http://127.0.0.1:8787/api/health";
const healthIntervalMs = Math.max(10000, Number(process.env.APP_HEALTH_INTERVAL_MS || 30000));
const healthFailureLimit = Math.max(2, Number(process.env.APP_HEALTH_FAILURE_LIMIT || 3));

let child;
let stopping = false;
let restartTimer;
let forcedKillTimer;
let consecutiveHealthFailures = 0;
let restartAttempts = 0;
let childStartedAt = 0;

function restartDelayMs() {
  if (Date.now() - childStartedAt > 60000) restartAttempts = 0;
  const delay = Math.min(30000, 1000 * 2 ** Math.min(restartAttempts, 5));
  restartAttempts += 1;
  return delay;
}

function startChild() {
  if (stopping) return;

  consecutiveHealthFailures = 0;
  childStartedAt = Date.now();
  child = spawn(
    process.execPath,
    [
      `--max-old-space-size=${maxOldSpaceMb}`,
      "--import",
      "tsx",
      "server/src/server.ts"
    ],
    {
      cwd: appRoot,
      env: process.env,
      stdio: "inherit",
      windowsHide: true
    }
  );

  console.log(`[supervisor] app started pid=${child.pid} heap_limit_mb=${maxOldSpaceMb}`);

  child.once("error", (error) => {
    console.error(`[supervisor] failed to start app: ${error.message}`);
  });

  child.once("exit", (code, signal) => {
    if (forcedKillTimer) {
      clearTimeout(forcedKillTimer);
      forcedKillTimer = undefined;
    }
    child = undefined;
    if (stopping) {
      process.exit(code ?? 0);
      return;
    }

    const delay = restartDelayMs();
    console.error(
      `[supervisor] app exited code=${code ?? "null"} signal=${signal ?? "none"}; restarting in ${delay}ms`
    );
    restartTimer = setTimeout(startChild, delay);
  });
}

function restartUnhealthyChild(reason) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  console.error(`[supervisor] ${reason}; restarting app pid=${child.pid}`);
  child.kill("SIGTERM");
  forcedKillTimer = setTimeout(() => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 10000);
  forcedKillTimer.unref();
}

async function checkHealth() {
  if (stopping || !child || Date.now() - childStartedAt < 45000) return;

  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const health = await response.json();
    if (health?.ok !== true) throw new Error("invalid health response");
    consecutiveHealthFailures = 0;
  } catch (error) {
    consecutiveHealthFailures += 1;
    console.error(
      `[supervisor] health check failed ${consecutiveHealthFailures}/${healthFailureLimit}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    if (consecutiveHealthFailures >= healthFailureLimit) {
      consecutiveHealthFailures = 0;
      restartUnhealthyChild("health check failure limit reached");
    }
  }
}

function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[supervisor] received ${signal}; stopping`);
  if (restartTimer) clearTimeout(restartTimer);
  if (!child) {
    process.exit(0);
    return;
  }
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    process.exit(0);
  }, 10000).unref();
}

process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGHUP", () => stop("SIGHUP"));

startChild();
setInterval(() => void checkHealth(), healthIntervalMs).unref();
