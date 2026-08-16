import assert from "node:assert/strict";
import test from "node:test";
import { createDecipheriv } from "node:crypto";
import { uploadIlinkImage } from "./media";

test("iLink image upload encrypts the PNG and returns an image message item", async () => {
  const image = Buffer.from("fake-png-bytes");
  const requests: Record<string, unknown>[] = [];
  let uploadUrl = "";
  let encrypted = Buffer.alloc(0);
  let randomCall = 0;
  const fileKey = Buffer.alloc(16, 1);
  const aesKey = Buffer.alloc(16, 2);

  const item = await uploadIlinkImage(image, "recipient@im.wechat", {
    randomBytes: () => (randomCall++ === 0 ? fileKey : aesKey),
    getUploadUrl: async (body) => {
      requests.push(body);
      return { upload_param: "signed upload value" };
    },
    fetch: async (url, init) => {
      uploadUrl = String(url);
      encrypted = Buffer.from(init?.body as Uint8Array);
      return new Response("", { status: 200, headers: { "x-encrypted-param": "download-reference" } });
    }
  });

  assert.equal(uploadUrl, "https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=signed%20upload%20value&filekey=01010101010101010101010101010101");
  assert.equal(requests[0].media_type, 1);
  assert.equal(requests[0].to_user_id, "recipient@im.wechat");
  assert.equal(requests[0].rawsize, image.length);
  assert.equal(requests[0].filesize, encrypted.length);

  const decipher = createDecipheriv("aes-128-ecb", aesKey, null);
  assert.deepEqual(Buffer.concat([decipher.update(encrypted), decipher.final()]), image);
  assert.deepEqual(item, {
    type: 2,
    image_item: {
      media: {
        encrypt_query_param: "download-reference",
        aes_key: Buffer.from(aesKey.toString("hex")).toString("base64"),
        encrypt_type: 1
      },
      mid_size: encrypted.length
    }
  });
});

test("iLink image upload refuses oversized notification cards before making requests", async () => {
  let called = false;
  await assert.rejects(
    uploadIlinkImage(Buffer.alloc(5 * 1024 * 1024 + 1), "recipient@im.wechat", {
      getUploadUrl: async () => {
        called = true;
        return {};
      }
    }),
    /invalid size/
  );
  assert.equal(called, false);
});
