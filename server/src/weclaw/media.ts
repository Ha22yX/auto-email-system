import { createCipheriv, createHash, randomBytes as nodeRandomBytes } from "node:crypto";

const DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const UPLOAD_ATTEMPTS = 3;

export type IlinkUploadUrlResponse = {
  upload_param?: string;
  upload_full_url?: string;
};

export type IlinkImageItem = {
  type: 2;
  image_item: {
    media: {
      encrypt_query_param: string;
      aes_key: string;
      encrypt_type: 1;
    };
    mid_size: number;
  };
};

export type IlinkImageUploadDependencies = {
  getUploadUrl: (body: Record<string, unknown>) => Promise<IlinkUploadUrlResponse>;
  fetch?: typeof globalThis.fetch;
  randomBytes?: (size: number) => Buffer;
  cdnBaseUrl?: string;
};

function encryptAesEcb(plaintext: Buffer, key: Buffer) {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function uploadUrl(response: IlinkUploadUrlResponse, cdnBaseUrl: string, fileKey: string) {
  const fullUrl = response.upload_full_url?.trim();
  if (fullUrl) return fullUrl;
  if (!response.upload_param) throw new Error("WeChat image upload URL is missing");
  return `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(response.upload_param)}&filekey=${encodeURIComponent(fileKey)}`;
}

async function uploadEncryptedImage(fetcher: typeof globalThis.fetch, url: string, ciphertext: Buffer) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetcher(url, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(ciphertext),
        signal: controller.signal
      });
      if (response.status >= 400 && response.status < 500) {
        throw new Error(`WeChat CDN rejected image upload (${response.status})`);
      }
      if (response.status !== 200) {
        throw new Error(`WeChat CDN image upload failed (${response.status})`);
      }
      const encryptedParam = response.headers.get("x-encrypted-param")?.trim();
      if (!encryptedParam) throw new Error("WeChat CDN response is missing image reference");
      return encryptedParam;
    } catch (error) {
      lastError = error;
      const nonRetryable = error instanceof Error && error.message.includes("rejected");
      if (nonRetryable || attempt === UPLOAD_ATTEMPTS) break;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("WeChat CDN image upload failed");
}

export async function uploadIlinkImage(
  image: Buffer,
  recipientId: string,
  dependencies: IlinkImageUploadDependencies
): Promise<IlinkImageItem> {
  if (!recipientId.trim()) throw new Error("WeChat image recipient is missing");
  if (!image.length || image.length > MAX_IMAGE_BYTES) throw new Error("WeChat notification image has an invalid size");

  const randomBytes = dependencies.randomBytes ?? nodeRandomBytes;
  const fileKey = randomBytes(16).toString("hex");
  const aesKey = randomBytes(16);
  const ciphertext = encryptAesEcb(image, aesKey);
  const response = await dependencies.getUploadUrl({
    filekey: fileKey,
    media_type: 1,
    to_user_id: recipientId,
    rawsize: image.length,
    rawfilemd5: createHash("md5").update(image).digest("hex"),
    filesize: ciphertext.length,
    no_need_thumb: true,
    aeskey: aesKey.toString("hex")
  });
  const target = uploadUrl(response, dependencies.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL, fileKey);
  const encryptedParam = await uploadEncryptedImage(dependencies.fetch ?? globalThis.fetch, target, ciphertext);

  return {
    type: 2,
    image_item: {
      media: {
        encrypt_query_param: encryptedParam,
        aes_key: Buffer.from(aesKey.toString("hex")).toString("base64"),
        encrypt_type: 1
      },
      mid_size: ciphertext.length
    }
  };
}
