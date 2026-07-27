import fs from "node:fs";
import path from "node:path";
import { normalizeUserId } from "./user-context";

const registryDir = path.resolve(process.env.USER_REGISTRY_DIR ?? "/lzcapp/var/registry");
const registryFile = path.join(registryDir, "users.json");

type UserRegistry = {
  version: 1;
  users: Record<string, { registeredAt: string; lastSeenAt: string }>;
};

function readRegistry(): UserRegistry {
  try {
    const value = JSON.parse(fs.readFileSync(registryFile, "utf8")) as Partial<UserRegistry>;
    return { version: 1, users: value.users ?? {} };
  } catch {
    return { version: 1, users: {} };
  }
}

function writeRegistry(registry: UserRegistry) {
  fs.mkdirSync(registryDir, { recursive: true });
  const temporary = `${registryFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(registry, null, 2), "utf8");
  fs.renameSync(temporary, registryFile);
}

export function registerUser(uid: string) {
  const userId = normalizeUserId(uid);
  const registry = readRegistry();
  const now = new Date().toISOString();
  registry.users[userId] = {
    registeredAt: registry.users[userId]?.registeredAt ?? now,
    lastSeenAt: now
  };
  writeRegistry(registry);
}

export function registeredUserIds() {
  return Object.keys(readRegistry().users).map(normalizeUserId);
}
