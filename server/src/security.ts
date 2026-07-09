import type express from "express";

type LoginAttempt = {
  failures: number;
  resetAt: number;
  blockedUntil: number;
};

type RateBucket = {
  count: number;
  resetAt: number;
};

const loginAttempts = new Map<string, LoginAttempt>();
const apiBuckets = new Map<string, RateBucket>();

const trustedHosts = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "147.189.128.208",
  "mail.rosebeg.com"
]);

const extraAllowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);

function now() {
  return Date.now();
}

function normalizeHost(value: string) {
  return value.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "").split(":")[0];
}

function clientKey(req: express.Request) {
  return req.ip || String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
}

function requestOrigin(req: express.Request) {
  return String(req.headers.origin || "").trim();
}

function requestHosts(req: express.Request) {
  return [
    String(req.headers.host || ""),
    String(req.headers["x-forwarded-host"] || "").split(",")[0]
  ]
    .map(normalizeHost)
    .filter(Boolean);
}

function sameSiteOrigin(req: express.Request, origin: string) {
  try {
    const parsed = new URL(origin);
    if (extraAllowedOrigins.has(parsed.origin)) return true;

    const originHost = normalizeHost(parsed.hostname);
    const hosts = requestHosts(req);
    if (hosts.includes(originHost)) return true;

    return trustedHosts.has(originHost) && hosts.some((host) => trustedHosts.has(host));
  } catch {
    return false;
  }
}

export function securityHeaders(req: express.Request, res: express.Response, next: express.NextFunction) {
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet, noimageindex");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'"
    ].join("; ")
  );
  if (req.secure || String(req.headers["x-forwarded-proto"] || "").includes("https")) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
}

export function corsOrigin(origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) {
  if (!origin) {
    callback(null, true);
    return;
  }
  try {
    const parsed = new URL(origin);
    if (extraAllowedOrigins.has(parsed.origin) || trustedHosts.has(normalizeHost(parsed.hostname))) {
      callback(null, true);
      return;
    }
  } catch {
    // Deny malformed origins.
  }
  callback(null, false);
}

export function csrfProtection(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    next();
    return;
  }

  const origin = requestOrigin(req);
  const referer = String(req.headers.referer || "").trim();
  const source = origin || referer;
  if (!source || sameSiteOrigin(req, source)) {
    next();
    return;
  }

  res.status(403).json({ error: "请求来源不可信，已拦截。" });
}

export function apiRateLimit(req: express.Request, res: express.Response, next: express.NextFunction) {
  const key = clientKey(req);
  const current = now();
  const windowMs = 5 * 60 * 1000;
  const maxRequests = 1200;
  const bucket = apiBuckets.get(key);

  if (!bucket || bucket.resetAt <= current) {
    apiBuckets.set(key, { count: 1, resetAt: current + windowMs });
    next();
    return;
  }

  bucket.count += 1;
  if (bucket.count > maxRequests) {
    res.setHeader("Retry-After", Math.ceil((bucket.resetAt - current) / 1000));
    res.status(429).json({ error: "请求过于频繁，请稍后再试。" });
    return;
  }

  next();
}

export function checkLoginAllowed(req: express.Request, res: express.Response) {
  const key = clientKey(req);
  const current = now();
  const attempt = loginAttempts.get(key);
  if (!attempt) return true;

  if (attempt.blockedUntil > current) {
    res.setHeader("Retry-After", Math.ceil((attempt.blockedUntil - current) / 1000));
    res.status(429).json({ error: "登录尝试过于频繁，请稍后再试。" });
    return false;
  }

  if (attempt.resetAt <= current) {
    loginAttempts.delete(key);
  }
  return true;
}

export function registerLoginFailure(req: express.Request) {
  const key = clientKey(req);
  const current = now();
  const windowMs = 10 * 60 * 1000;
  const blockMs = 15 * 60 * 1000;
  const maxFailures = 8;
  const attempt = loginAttempts.get(key);

  if (!attempt || attempt.resetAt <= current) {
    loginAttempts.set(key, { failures: 1, resetAt: current + windowMs, blockedUntil: 0 });
    return;
  }

  attempt.failures += 1;
  if (attempt.failures >= maxFailures) {
    attempt.blockedUntil = current + blockMs;
  }
}

export function registerLoginSuccess(req: express.Request) {
  loginAttempts.delete(clientKey(req));
}
