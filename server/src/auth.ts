import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type express from "express";
import * as oidc from "openid-client";
import { registerUser } from "./user-registry";
import { normalizeUserId, runAsUser } from "./user-context";

const SESSION_COOKIE = "auto_mail_oidc_session";
const TRANSACTION_COOKIE = "auto_mail_oidc_transaction";
const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;
const TRANSACTION_MAX_AGE_SECONDS = 10 * 60;

type Session = { uid: string; exp: number };
type Transaction = {
  state: string;
  nonce: string;
  verifier: string;
  exp: number;
  origin: string;
  gatewayUid?: string;
};

function configurationError() {
  return new Error("懒猫 OIDC 尚未配置，请在 LPK 环境中启动应用。");
}

function oidcClientId() {
  const value = process.env.OIDC_CLIENT_ID;
  if (!value) throw configurationError();
  return value;
}

function signingKey() {
  const value = process.env.OIDC_CLIENT_SECRET;
  if (!value) throw configurationError();
  return value;
}

function base64Url(value: Buffer | string) {
  return Buffer.from(value).toString("base64url");
}

function sign(value: string) {
  return createHmac("sha256", signingKey()).update(value).digest("base64url");
}

function encode(value: object) {
  const payload = base64Url(JSON.stringify(value));
  return `${payload}.${sign(payload)}`;
}

function decode<T>(value: string | undefined): T | undefined {
  if (!value) return undefined;
  const [payload, signature] = value.split(".");
  if (!payload || !signature) return undefined;
  const expected = Buffer.from(sign(payload), "base64url");
  const received = Buffer.from(signature, "base64url");
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return undefined;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as T;
  } catch {
    return undefined;
  }
}

function parseCookies(header: string | undefined) {
  const cookies = new Map<string, string>();
  for (const part of (header || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    cookies.set(part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim()));
  }
  return cookies;
}

function secure(req: express.Request) {
  return req.secure || String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
}

function cookie(req: express.Request, name: string, value: string, maxAge: number) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    secure(req) ? "Secure" : ""
  ].filter(Boolean).join("; ");
}

function origin(req: express.Request) {
  const proto = String(req.headers["x-forwarded-proto"] || (req.secure ? "https" : req.protocol) || "https")
    .split(",")[0]
    .trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  if (!host) throw new Error("无法确定 OIDC 回调域名。");
  return `${proto}://${host}`;
}

function gatewayUser(req: express.Request) {
  return String(req.headers["x-hc-user-id"] || req.headers["safe_uid"] || "").trim();
}

type OidcIdentity = {
  sub?: unknown;
  preferred_username?: unknown;
};

function claimValue(identity: OidcIdentity | undefined, name: keyof OidcIdentity) {
  const value = identity?.[name];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * OIDC `sub` is an opaque identity-provider identifier. It is only a fallback
 * for requests that did not pass through lzc-ingress.
 */
export function oidcUserId(profile: OidcIdentity | undefined, claims: OidcIdentity | undefined) {
  return normalizeUserId(
    claimValue(profile, "sub") ||
      claimValue(claims, "sub")
  );
}

/**
 * lzc-ingress is the authority for the active Lazycat account. Its UID and
 * OIDC claims use different identifier namespaces, so comparing them is both
 * unreliable and unnecessary. OIDC still proves that the authorization flow
 * completed; the trusted ingress UID selects the account data.
 */
export function authenticatedLazycatUser(
  ingressUid: string | undefined,
  profile: OidcIdentity | undefined,
  claims: OidcIdentity | undefined
) {
  return ingressUid ? normalizeUserId(ingressUid) : oidcUserId(profile, claims);
}

async function oidcConfiguration(callbackUrl: string) {
  const issuer = process.env.OIDC_ISSUER_URI;
  if (!issuer) throw configurationError();
  return oidc.discovery(
    new URL(issuer),
    oidcClientId(),
    { redirect_uris: [callbackUrl], response_types: ["code"] },
    oidc.ClientSecretBasic(signingKey())
  );
}

export function getSession(req: express.Request): Session | undefined {
  const session = decode<Session>(parseCookies(req.headers.cookie).get(SESSION_COOKIE));
  if (!session || !session.uid || session.exp <= Math.floor(Date.now() / 1000)) return undefined;
  const ingressUid = gatewayUser(req);
  if (ingressUid && normalizeUserId(ingressUid) !== session.uid) return undefined;
  return session;
}

export async function beginOidcLogin(req: express.Request, res: express.Response) {
  const callbackUrl = `${origin(req)}/api/auth/oidc/callback`;
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const verifier = oidc.randomPKCECodeVerifier();
  const challenge = await oidc.calculatePKCECodeChallenge(verifier);
  const transaction: Transaction = {
    state,
    nonce,
    verifier,
    exp: Math.floor(Date.now() / 1000) + TRANSACTION_MAX_AGE_SECONDS,
    origin: origin(req),
    gatewayUid: gatewayUser(req) || undefined
  };
  const config = await oidcConfiguration(callbackUrl);
  const authorizationUrl = oidc.buildAuthorizationUrl(config, {
    redirect_uri: callbackUrl,
    scope: "openid profile email groups",
    response_type: "code",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256"
  });
  res.setHeader("Set-Cookie", cookie(req, TRANSACTION_COOKIE, encode(transaction), TRANSACTION_MAX_AGE_SECONDS));
  res.redirect(302, authorizationUrl.href);
}

export async function completeOidcLogin(req: express.Request, res: express.Response) {
  const transaction = decode<Transaction>(parseCookies(req.headers.cookie).get(TRANSACTION_COOKIE));
  if (!transaction || transaction.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error("登录请求已过期，请回到登录页重新发起授权。");
  }
  const callbackUrl = `${transaction.origin}/api/auth/oidc/callback`;
  const config = await oidcConfiguration(callbackUrl);
  const currentUrl = new URL(req.originalUrl, transaction.origin);
  const tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
    expectedState: transaction.state,
    expectedNonce: transaction.nonce,
    pkceCodeVerifier: transaction.verifier
  });
  const claims = tokens.claims();
  const profile = claims?.sub && tokens.access_token
    ? await oidc.fetchUserInfo(config, tokens.access_token, claims.sub)
    : claims;
  const ingressUid = gatewayUser(req) || transaction.gatewayUid;
  const uid = authenticatedLazycatUser(ingressUid, profile, claims);
  registerUser(uid);
  const session: Session = { uid, exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS };
  res.setHeader("Set-Cookie", [
    cookie(req, SESSION_COOKIE, encode(session), SESSION_MAX_AGE_SECONDS),
    cookie(req, TRANSACTION_COOKIE, "", 0)
  ]);
  res.redirect(302, "/");
}

export function clearAuthCookie(req: express.Request, res: express.Response) {
  res.setHeader("Set-Cookie", cookie(req, SESSION_COOKIE, "", 0));
}

export function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const session = getSession(req);
  if (!session) {
    clearAuthCookie(req, res);
    res.status(401).json({ error: "请通过懒猫账号登录。", authenticated: false });
    return;
  }
  runAsUser(session.uid, () => next());
}
