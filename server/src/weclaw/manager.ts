import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type WeclawState = {
  child?: ChildProcessWithoutNullStreams;
  lastExit?: {
    code: number | null;
    signal: NodeJS.Signals | null;
    at: string;
  };
};

const state: WeclawState = {};
let qrLogMode = false;
const rootDir = path.resolve(process.cwd());
const toolDir = path.join(rootDir, "tools", "weclaw");
const logDir = path.join(rootDir, "data");
const logFile = path.join(logDir, "weclaw.log");
export const defaultWeclawApiUrl = "http://127.0.0.1:18011/api/send";

type WeclawCredential = {
  botToken?: string;
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  baseurl?: string;
};

type WeclawContextTokenStore = {
  updated_at?: string;
  tokens?: Record<string, string>;
};

export type WeclawAccount = {
  botId: string;
  recipientId: string;
  path: string;
  updatedAt: string;
};

function executableName() {
  if (process.platform === "win32") {
    return process.arch === "arm64" ? "weclaw_windows_arm64.exe" : "weclaw_windows_amd64.exe";
  }
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "weclaw_darwin_arm64" : "weclaw_darwin_amd64";
  }
  if (process.platform === "linux") {
    return process.arch === "arm64" ? "weclaw_linux_arm64" : "weclaw_linux_amd64";
  }
  return "weclaw";
}

function executablePath() {
  return process.env.WECLAW_BIN || path.join(toolDir, "bin", executableName());
}

function credentialsDir() {
  return path.join(os.homedir(), ".weclaw", "accounts");
}

function contextTokensPath() {
  return path.join(os.homedir(), ".weclaw", "context_tokens.json");
}

function readWeclawContextTokens() {
  const filePath = contextTokensPath();
  if (!fs.existsSync(filePath)) {
    return {
      path: filePath,
      updatedAt: "",
      tokens: {} as Record<string, string>
    };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as WeclawContextTokenStore;
    return {
      path: filePath,
      updatedAt: raw.updated_at || "",
      tokens: raw.tokens || {}
    };
  } catch {
    return {
      path: filePath,
      updatedAt: "",
      tokens: {} as Record<string, string>
    };
  }
}

export function readWeclawAccounts(): WeclawAccount[] {
  const dir = credentialsDir();
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const filePath = path.join(dir, name);
      try {
        const stat = fs.statSync(filePath);
        const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as WeclawCredential;
        return {
          botId: raw.ilink_bot_id || "",
          recipientId: raw.ilink_user_id || "",
          path: filePath,
          updatedAt: stat.mtime.toISOString()
        };
      } catch {
        return undefined;
      }
    })
    .filter((account): account is WeclawAccount => Boolean(account?.botId && account.recipientId))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function resolveWeclawRecipientId(fallback = "") {
  return fallback.trim() || readWeclawAccounts()[0]?.recipientId || "";
}

function appendLog(source: string, chunk: Buffer | string) {
  fs.mkdirSync(logDir, { recursive: true });
  const text = String(chunk);
  const lines = text
    .split(/\r\n|\n|\r/)
    .filter(Boolean)
    .map((line) => {
      if (line.includes("Scan this QR code with WeChat")) {
        qrLogMode = true;
        return `[${new Date().toISOString()}] [${source}] ${line}`;
      }
      if (qrLogMode && (line.includes("QR URL:") || line.includes("Waiting for scan"))) {
        if (line.includes("Waiting for scan")) qrLogMode = false;
        return `[${new Date().toISOString()}] [${source}] ${line}`;
      }
      if (qrLogMode) return line;
      return `[${new Date().toISOString()}] [${source}] ${line}`;
    })
    .join("\n");
  if (lines) fs.appendFileSync(logFile, `${lines}\n`, "utf8");
}

function readLogTail(lines = 120) {
  if (!fs.existsSync(logFile)) return "";
  const content = fs.readFileSync(logFile, "utf8");
  return content.split(/\r\n|\n|\r/).slice(-lines).join("\n").trim();
}

function apiUrlToBase(apiUrl: string) {
  const url = new URL(apiUrl || defaultWeclawApiUrl);
  return `${url.protocol}//${url.host}`;
}

function apiUrlToAddr(apiUrl: string) {
  const url = new URL(apiUrl || defaultWeclawApiUrl);
  return url.host;
}

async function isApiReachable(apiUrl: string, timeoutMs = 1500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(apiUrlToBase(apiUrl), {
      method: "GET",
      signal: controller.signal
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function managedRunning() {
  return Boolean(state.child && !state.child.killed && state.child.exitCode === null);
}

export async function getWeclawStatus(apiUrl: string) {
  const exe = executablePath();
  const installed = fs.existsSync(exe);
  const apiReachable = await isApiReachable(apiUrl);
  const accounts = readWeclawAccounts();
  const activeAccount = accounts[0];
  const contextTokens = readWeclawContextTokens();
  const activeContextToken = activeAccount?.recipientId ? contextTokens.tokens[activeAccount.recipientId] : "";
  return {
    installed,
    executablePath: exe,
    apiUrl: apiUrl || defaultWeclawApiUrl,
    apiBaseUrl: apiUrlToBase(apiUrl),
    apiReachable,
    running: managedRunning() || apiReachable,
    managedRunning: managedRunning(),
    managedPid: managedRunning() ? state.child?.pid : undefined,
    hasCredentials: accounts.length > 0,
    credentialCount: accounts.length,
    credentialsPath: credentialsDir(),
    recipientId: activeAccount?.recipientId,
    botId: activeAccount?.botId,
    contextTokenPath: contextTokens.path,
    contextReady: Boolean(activeContextToken),
    contextUpdatedAt: contextTokens.updatedAt,
    lastExit: state.lastExit,
    logTail: readLogTail()
  };
}

export async function startWeclaw(apiUrl: string) {
  const status = await getWeclawStatus(apiUrl);
  if (status.apiReachable) {
    return {
      ...status,
      message: "WeClaw API 已在线。"
    };
  }
  if (status.managedRunning) {
    return {
      ...status,
      message: "WeClaw 已由本项目启动。"
    };
  }
  if (!status.installed) {
    throw new Error(`未找到项目内 WeClaw 运行文件：${status.executablePath}`);
  }

  fs.mkdirSync(logDir, { recursive: true });
  appendLog("system", `starting ${status.executablePath} start -f`);
  state.child = spawn(status.executablePath, ["start", "-f"], {
    cwd: toolDir,
    env: {
      ...process.env,
      WECLAW_API_ADDR: apiUrlToAddr(apiUrl)
    },
    windowsHide: true
  });

  state.child.stdout.on("data", (chunk) => appendLog("stdout", chunk));
  state.child.stderr.on("data", (chunk) => appendLog("stderr", chunk));
  state.child.on("exit", (code, signal) => {
    state.lastExit = {
      code,
      signal,
      at: new Date().toISOString()
    };
    appendLog("system", `weclaw exited code=${code ?? ""} signal=${signal ?? ""}`);
  });

  await new Promise((resolve) => setTimeout(resolve, 1200));
  return {
    ...(await getWeclawStatus(apiUrl)),
    message: "已从项目目录启动 WeClaw。首次运行请查看日志里的二维码并用手机微信扫码。"
  };
}

export async function stopWeclaw(apiUrl: string) {
  if (managedRunning() && state.child) {
    appendLog("system", "stopping managed weclaw process");
    state.child.kill();
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  return {
    ...(await getWeclawStatus(apiUrl)),
    message: "已请求停止本项目启动的 WeClaw。"
  };
}

export function getWeclawLogTail(lines = 160) {
  return {
    logTail: readLogTail(lines),
    logFile
  };
}

process.once("exit", () => {
  if (managedRunning() && state.child) {
    state.child.kill();
  }
});
