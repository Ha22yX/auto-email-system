import assert from "node:assert/strict";
import test from "node:test";

process.env.QQ_CREDENTIAL_ENCRYPTION_KEY ??= "test-only-qq-credential-encryption-key";

const { decryptCredential, encryptCredential } = await import("./credential-crypto");

test("QQ AppSecret encryption uses a versioned envelope without exposing plaintext", () => {
  const secret = "test-secret";
  const envelope = encryptCredential(secret);

  assert.match(envelope, /^v1:[^:]+:[^:]+:[^:]+$/);
  assert.equal(envelope.includes(secret), false);
  assert.equal(decryptCredential(envelope), secret);
});

test("QQ AppSecret decryption rejects a modified authentication tag", () => {
  const envelope = encryptCredential("test-secret");
  const [version, iv, tag, ciphertext] = envelope.split(":");
  const modifiedTag = `${tag.startsWith("A") ? "B" : "A"}${tag.slice(1)}`;

  assert.throws(() => decryptCredential(`${version}:${iv}:${modifiedTag}:${ciphertext}`));
});
