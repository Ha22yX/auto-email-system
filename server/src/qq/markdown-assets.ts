import fs from "node:fs";
import path from "node:path";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { tmpdir } from "node:os";

const ASSET_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const MAX_ASSET_BYTES = 5 * 1024 * 1024;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IHDR = Buffer.from("IHDR", "ascii");
const DEFAULT_DATA_DIR = process.env.NODE_TEST_CONTEXT
  ? path.join(tmpdir(), `auto-email-system-test-${process.pid}`)
  : "data";
const ASSET_DIR = path.join(path.resolve(process.env.DATA_DIR ?? DEFAULT_DATA_DIR), "qq-notification-assets");

let cleanupTimer: ReturnType<typeof setInterval> | undefined;

function signingKey() {
  const source = process.env.QQ_CREDENTIAL_ENCRYPTION_KEY ?? process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!source) throw new Error("QQ_CREDENTIAL_ENCRYPTION_KEY is required for QQ Markdown assets");
  return createHash("sha256").update(`qq-markdown-assets:${source}`).digest();
}

function publicBaseUrl() {
  const configured = String(process.env.PUBLIC_BASE_URL || "").trim();
  if (!configured) throw new Error("PUBLIC_BASE_URL is required for QQ Markdown image notifications");
  const parsed = new URL(configured);
  const local = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
    throw new Error("PUBLIC_BASE_URL must use HTTPS");
  }
  parsed.pathname = parsed.pathname.replace(/\/$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function signature(token: string, expires: number) {
  return createHmac("sha256", signingKey()).update(`${token}.${expires}`).digest("base64url");
}

function equalSignature(expected: string, actual: string) {
  try {
    const left = Buffer.from(expected, "base64url");
    const right = Buffer.from(actual, "base64url");
    return left.length === right.length && timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function assetPath(token: string) {
  return path.join(ASSET_DIR, `${token}.png`);
}

export function cleanupQqMarkdownAssets(now = Date.now()) {
  fs.mkdirSync(ASSET_DIR, { recursive: true });
  const cutoff = now - ASSET_TTL_MS;
  let removed = 0;
  for (const entry of fs.readdirSync(ASSET_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".png") || !TOKEN_PATTERN.test(entry.name.slice(0, -4))) continue;
    const file = path.join(ASSET_DIR, entry.name);
    try {
      if (fs.statSync(file).mtimeMs >= cutoff) continue;
      fs.unlinkSync(file);
      removed += 1;
    } catch {
      // A concurrent request or cleanup may already have removed the file.
    }
  }
  return removed;
}

export function startQqMarkdownAssetCleanupWorker() {
  cleanupQqMarkdownAssets();
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => cleanupQqMarkdownAssets(), CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();
}

export function stopQqMarkdownAssetCleanupWorker() {
  if (!cleanupTimer) return;
  clearInterval(cleanupTimer);
  cleanupTimer = undefined;
}

export function createQqMarkdownAsset(image: Buffer, now = Date.now()) {
  if (
    image.length < 24 ||
    image.length > MAX_ASSET_BYTES ||
    !image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
    image.readUInt32BE(8) !== 13 ||
    !image.subarray(12, 16).equals(PNG_IHDR)
  ) {
    throw new Error("QQ Markdown notification asset must be a bounded PNG image");
  }
  const width = image.readUInt32BE(16);
  const height = image.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 8_192 || height > 8_192) {
    throw new Error("QQ Markdown notification asset has invalid dimensions");
  }

  fs.mkdirSync(ASSET_DIR, { recursive: true });
  cleanupQqMarkdownAssets(now);
  const token = randomBytes(24).toString("base64url");
  const expires = Math.floor((now + ASSET_TTL_MS) / 1000);
  fs.writeFileSync(assetPath(token), image, { flag: "wx", mode: 0o600 });
  const url = new URL(`${publicBaseUrl()}/api/qq-assets/${token}.png`);
  url.searchParams.set("expires", String(expires));
  url.searchParams.set("signature", signature(token, expires));
  return { token, expires, url: url.toString(), width, height };
}

export function removeQqMarkdownAsset(token: string) {
  if (!TOKEN_PATTERN.test(token)) return;
  try {
    fs.unlinkSync(assetPath(token));
  } catch {
    // Missing files are already removed.
  }
}

export function resolveQqMarkdownAsset(token: string, expiresValue: string, suppliedSignature: string, now = Date.now()) {
  if (!TOKEN_PATTERN.test(token) || !/^\d{10}$/.test(expiresValue)) return undefined;
  const expires = Number(expiresValue);
  const nowSeconds = Math.floor(now / 1000);
  if (expires < nowSeconds || expires > nowSeconds + Math.ceil(ASSET_TTL_MS / 1000) + 300) return undefined;
  if (!equalSignature(signature(token, expires), suppliedSignature)) return undefined;

  const file = assetPath(token);
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_ASSET_BYTES) return undefined;
    return { file, expires };
  } catch {
    return undefined;
  }
}

export const QQ_MARKDOWN_ASSET_TTL_MS = ASSET_TTL_MS;
