import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  cleanupQqMarkdownAssets,
  createQqMarkdownAsset,
  QQ_MARKDOWN_ASSET_TTL_MS,
  removeQqMarkdownAsset,
  resolveQqMarkdownAsset
} from "./markdown-assets";

process.env.QQ_CREDENTIAL_ENCRYPTION_KEY ??= "test-only-qq-markdown-asset-key";
process.env.PUBLIC_BASE_URL ??= "https://mail.example.com";

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0x00, 0x00, 0x00, 0x0d]),
  Buffer.from("IHDR"),
  Buffer.from([0x00, 0x00, 0x04, 0x38, 0x00, 0x00, 0x05, 0x56]),
  Buffer.from("test-png")
]);

test("QQ Markdown assets use signed HTTPS URLs and reject modified signatures", () => {
  const now = Date.now();
  const asset = createQqMarkdownAsset(png, now);
  const url = new URL(asset.url);
  const expires = url.searchParams.get("expires") ?? "";
  const signature = url.searchParams.get("signature") ?? "";

  assert.equal(url.origin, "https://mail.example.com");
  assert.match(url.pathname, /^\/api\/qq-assets\/[A-Za-z0-9_-]{32}\.png$/);
  assert.equal(asset.expires, Math.floor((now + QQ_MARKDOWN_ASSET_TTL_MS) / 1000));
  assert.equal(asset.width, 1080);
  assert.equal(asset.height, 1366);
  assert.ok(resolveQqMarkdownAsset(asset.token, expires, signature, now));
  assert.equal(resolveQqMarkdownAsset(asset.token, expires, `${signature}x`, now), undefined);
  assert.equal(resolveQqMarkdownAsset(asset.token, expires, signature, now + QQ_MARKDOWN_ASSET_TTL_MS + 1_000), undefined);
  removeQqMarkdownAsset(asset.token);
});

test("QQ Markdown asset cleanup removes files older than three days", () => {
  const now = Date.now();
  const asset = createQqMarkdownAsset(png, now);
  const url = new URL(asset.url);
  const resolved = resolveQqMarkdownAsset(
    asset.token,
    url.searchParams.get("expires") ?? "",
    url.searchParams.get("signature") ?? "",
    now
  );
  assert.ok(resolved);

  const old = new Date(now - QQ_MARKDOWN_ASSET_TTL_MS - 1_000);
  fs.utimesSync(resolved.file, old, old);
  assert.equal(cleanupQqMarkdownAssets(now), 1);
  assert.equal(fs.existsSync(resolved.file), false);
});
