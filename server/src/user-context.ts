import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import path from "node:path";

const context = new AsyncLocalStorage<{ uid: string }>();

export function normalizeUserId(value: string) {
  const uid = value.trim();
  if (!uid || uid.length > 256 || /[\\/\0]/.test(uid)) {
    throw new Error("无效的懒猫账户标识。");
  }
  return uid;
}

export function userDirectoryName(uid: string) {
  return createHash("sha256").update(normalizeUserId(uid)).digest("hex");
}

export function userDataPath(uid: string) {
  const root = path.resolve(process.env.USER_DATA_ROOT ?? path.join(process.env.DATA_DIR ?? "data", "users"));
  return path.join(root, encodeURIComponent(normalizeUserId(uid)), "auto-email-system");
}

export function currentUserId() {
  const uid = context.getStore()?.uid;
  if (!uid) throw new Error("当前操作缺少懒猫账户上下文。");
  return uid;
}

export function runAsUser<T>(uid: string, operation: () => T): T {
  return context.run({ uid: normalizeUserId(uid) }, operation);
}
