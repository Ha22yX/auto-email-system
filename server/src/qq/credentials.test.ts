import assert from "node:assert/strict";
import test from "node:test";
import { createTokenProvider } from "./credentials";

const TEST_CONFIG = {
  appId: "test-app-id",
  encryptedAppSecret: "encrypted-test-secret",
  enabled: true,
  notifyCategories: { important: true, secondary: true, ignore: false }
};

function createTokenFetch(tokens: Array<{ access_token: string; expires_in: number }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const token = tokens.shift();
    if (!token) throw new Error("unexpected token request");
    return new Response(JSON.stringify(token), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  return { calls, fetch };
}

test("requests and caches an official QQ access token until the early-refresh window", async () => {
  let now = 0;
  const fake = createTokenFetch([
    { access_token: "fake-token-one", expires_in: 180 },
    { access_token: "fake-token-two", expires_in: 180 }
  ]);
  const provider = createTokenProvider({
    fetch: fake.fetch,
    readConfig: () => TEST_CONFIG,
    decryptCredential: () => "fake-app-secret",
    now: () => now
  });

  assert.equal(await provider.getToken(), "fake-token-one");
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].url, "https://api.bot.qq.com/app/getAppAccessToken");
  assert.deepEqual(JSON.parse(String(fake.calls[0].init?.body)), {
    appId: "test-app-id",
    clientSecret: "fake-app-secret"
  });

  now = 89_999;
  assert.equal(await provider.getToken(), "fake-token-one");
  assert.equal(fake.calls.length, 1);

  now = 90_000;
  assert.equal(await provider.getToken(), "fake-token-two");
  assert.equal(fake.calls.length, 2);
});

test("concurrent token requests share one HTTP call", async () => {
  let resolveResponse: ((response: Response) => void) | undefined;
  let calls = 0;
  const provider = createTokenProvider({
    fetch: async () => {
      calls += 1;
      return new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      });
    },
    readConfig: () => TEST_CONFIG,
    decryptCredential: () => "fake-app-secret"
  });

  const first = provider.getToken();
  const second = provider.getToken();
  await Promise.resolve();
  assert.equal(calls, 1);

  resolveResponse?.(
    new Response(JSON.stringify({ access_token: "fake-shared-token", expires_in: 300 }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })
  );

  assert.deepEqual(await Promise.all([first, second]), ["fake-shared-token", "fake-shared-token"]);
});

test("invalidation and force refresh acquire one new token", async () => {
  const fake = createTokenFetch([
    { access_token: "fake-token-one", expires_in: 300 },
    { access_token: "fake-token-two", expires_in: 300 }
  ]);
  const provider = createTokenProvider({
    fetch: fake.fetch,
    readConfig: () => TEST_CONFIG,
    decryptCredential: () => "fake-app-secret"
  });

  await provider.getToken();
  provider.invalidate();
  assert.equal(await provider.getToken({ force: true }), "fake-token-two");
  assert.equal(fake.calls.length, 2);
});

test("token failures are sanitized and never expose fake secrets", async () => {
  const provider = createTokenProvider({
    fetch: async () =>
      new Response(JSON.stringify({ code: 1001, message: "fake-app-secret fake-access-token" }), {
        status: 401,
        headers: { "content-type": "application/json" }
      }),
    readConfig: () => TEST_CONFIG,
    decryptCredential: () => "fake-app-secret"
  });

  await assert.rejects(provider.getToken(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message.includes("fake-app-secret"), false);
    assert.equal(error.message.includes("fake-access-token"), false);
    return true;
  });
});
