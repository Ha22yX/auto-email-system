import dns from "node:dns/promises";
import net from "node:net";
import { simpleParser } from "mailparser";
import type { ProcessedEmail } from "../types";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const allowedImageTypes = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp"
]);

export type SafeImageAsset = {
  content: Buffer;
  contentType: string;
};

function isBlockedHostname(hostname: string) {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal")
  );
}

function isPrivateAddress(address: string) {
  const family = net.isIP(address);
  if (family === 4) {
    const parts = address.split(".").map(Number);
    const [a, b] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }

  if (family === 6) {
    const normalized = address.toLowerCase();
    const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mappedIpv4) return isPrivateAddress(mappedIpv4[1]);
    return (
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe80:") ||
      normalized.startsWith("::ffff:127.") ||
      normalized.startsWith("::ffff:10.") ||
      normalized.startsWith("::ffff:192.168.")
    );
  }

  return true;
}

async function assertSafeRemoteUrl(url: URL) {
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("只允许加载 HTTP/HTTPS 图片。");
  }
  if (url.username || url.password) {
    throw new Error("图片地址不能包含认证信息。");
  }
  if (url.port && !["80", "443"].includes(url.port)) {
    throw new Error("图片地址端口不被允许。");
  }
  if (isBlockedHostname(url.hostname)) {
    throw new Error("图片地址主机不被允许。");
  }

  const addresses = await dns.lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error("图片地址解析到内网或本机地址，已拦截。");
  }
}

function normalizeImageContentType(value: string | null) {
  return (value || "").split(";", 1)[0].trim().toLowerCase();
}

export async function fetchRemoteEmailImage(urlText: string): Promise<SafeImageAsset> {
  let current = new URL(urlText);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    await assertSafeRemoteUrl(current);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.1",
          "User-Agent": "AutoEmailSystemImageProxy/1.0"
        }
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new Error("图片重定向缺少目标地址。");
        current = new URL(location, current);
        continue;
      }

      if (!response.ok) {
        throw new Error(`图片加载失败: ${response.status}`);
      }

      const contentType = normalizeImageContentType(response.headers.get("content-type"));
      if (!allowedImageTypes.has(contentType)) {
        throw new Error("图片类型不被允许。");
      }

      const contentLength = Number(response.headers.get("content-length") || 0);
      if (contentLength > MAX_IMAGE_BYTES) {
        throw new Error("图片过大，已拦截。");
      }

      const content = Buffer.from(await response.arrayBuffer());
      if (content.length > MAX_IMAGE_BYTES) {
        throw new Error("图片过大，已拦截。");
      }

      return { content, contentType };
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error("图片重定向次数过多。");
}

function normalizeCid(value: string) {
  return decodeURIComponent(value)
    .replace(/^cid:/i, "")
    .replace(/^<|>$/g, "")
    .trim();
}

export async function findInlineEmailImage(email: ProcessedEmail, cidValue: string): Promise<SafeImageAsset | null> {
  if (!email.rawSource) return null;

  const targetCid = normalizeCid(cidValue);
  const parsed = await simpleParser(email.rawSource);
  const attachment = parsed.attachments.find((item) => {
    const cid = normalizeCid(item.cid || item.contentId || "");
    return cid && cid === targetCid;
  });

  if (!attachment) return null;

  const contentType = normalizeImageContentType(attachment.contentType);
  if (!allowedImageTypes.has(contentType)) {
    throw new Error("内嵌图片类型不被允许。");
  }
  if (attachment.content.length > MAX_IMAGE_BYTES) {
    throw new Error("内嵌图片过大，已拦截。");
  }

  return {
    content: attachment.content,
    contentType
  };
}
