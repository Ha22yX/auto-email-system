import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "auto-email-system-test-"));
process.env.USER_DATA_ROOT = path.join(root, "documents");

const { runAsUser, userDataPath } = await import("./user-context");
const { readState, upsertMailbox } = await import("./store");
const { authenticatedLazycatUser, oidcUserId } = await import("./auth");

test("each Lazycat UID receives a separate SQLite state", () => {
  runAsUser("alice", () => {
    upsertMailbox({
      name: "Alice mailbox",
      email: "alice@example.com",
      protocol: "imap",
      host: "imap.example.com",
      port: 993,
      secure: true,
      username: "alice",
      password: "secret",
      folder: "INBOX",
      enabled: true
    });
    assert.equal(readState().mailboxes.length, 1);
  });

  runAsUser("bob", () => {
    assert.equal(readState().mailboxes.length, 0);
  });

  assert.notEqual(userDataPath("alice"), userDataPath("bob"));
});

test("uses the trusted ingress UID when the OIDC subject is opaque", () => {
  const profile = { sub: "9b4d0d9c-0af6-4df5-9fca-8d3d020d5c0a", preferred_username: "alice" };

  assert.equal(oidcUserId(profile, undefined), "9b4d0d9c-0af6-4df5-9fca-8d3d020d5c0a");
  assert.equal(authenticatedLazycatUser("alice", profile, undefined), "alice");
});

test("falls back to the OIDC subject without an ingress UID", () => {
  const profile = { sub: "opaque-subject", preferred_username: "alice" };

  assert.equal(authenticatedLazycatUser(undefined, profile, undefined), "opaque-subject");
});
