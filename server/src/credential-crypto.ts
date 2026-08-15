import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { EncryptedCredential } from "./types";

const ENVELOPE_VERSION = "v1";
const IV_BYTES = 12;

function encryptionKey() {
  const source = process.env.QQ_CREDENTIAL_ENCRYPTION_KEY ?? process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!source) throw new Error("QQ_CREDENTIAL_ENCRYPTION_KEY is required to encrypt QQ credentials");
  return createHash("sha256").update(source).digest();
}

export function encryptCredential(value: string): EncryptedCredential {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENVELOPE_VERSION}:${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

export function decryptCredential(envelope: string): string {
  const [version, ivBase64, tagBase64, ciphertextBase64, extra] = envelope.split(":");
  if (version !== ENVELOPE_VERSION || !ivBase64 || !tagBase64 || !ciphertextBase64 || extra) {
    throw new Error("Invalid encrypted credential envelope");
  }

  const iv = Buffer.from(ivBase64, "base64");
  const tag = Buffer.from(tagBase64, "base64");
  const ciphertext = Buffer.from(ciphertextBase64, "base64");
  if (iv.length !== IV_BYTES || tag.length !== 16 || !ciphertext.length) {
    throw new Error("Invalid encrypted credential envelope");
  }

  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
