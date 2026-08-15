import assert from "node:assert/strict";
import test from "node:test";
import { createQqClient } from "./client";
import { QqApiError } from "./types";

type TokenProviderStub = {
  calls: Array<{ force?: boolean } | undefined>;
  invalidations: number;
  getToken(options?: { force?: boolean }): Promise<string>;
  invalidate(): void;
};

function createTokenProvider(): TokenProviderStub {
  return {
    calls: [],
    invalidations: 0,
    async getToken(options) {
      this.calls.push(options);
      return options?.force ? "fake-refreshed-token" : "fake-access-token";
    },
    invalidate() {
      this.invalidations += 1;
    }
  };
}

function createMessageFetch(responses: Response[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const response = responses.shift();
    if (!response) throw new Error("unexpected message request");
    return response;
  };

  return { calls, fetch };
}

test("active direct messages omit msg_id and use the official QQ endpoint", async () => {
  const tokenProvider = createTokenProvider();
  const fake = createMessageFetch([
    new Response(JSON.stringify({ id: "message-1" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })
  ]);
  const client = createQqClient({ fetch: fake.fetch, tokenProvider });

  assert.deepEqual(await client.sendDirectMessage({ userOpenId: "user-openid", content: "hello" }), {
    messageId: "message-1"
  });
  assert.equal(fake.calls[0].url, "https://api.bot.qq.com/v2/users/user-openid/messages");
  assert.equal(new Headers(fake.calls[0].init?.headers).get("authorization"), "QQBot fake-access-token");
  assert.deepEqual(JSON.parse(String(fake.calls[0].init?.body)), { content: "hello", msg_type: 0 });
});

test("passive direct messages include the incoming msg_id", async () => {
  const tokenProvider = createTokenProvider();
  const fake = createMessageFetch([new Response(JSON.stringify({ id: "message-2" }), { status: 200 })]);
  const client = createQqClient({ fetch: fake.fetch, tokenProvider });

  await client.sendDirectMessage({ userOpenId: "user-openid", content: "bound", msgId: "incoming-message-id" });
  assert.deepEqual(JSON.parse(String(fake.calls[0].init?.body)), {
    content: "bound",
    msg_id: "incoming-message-id",
    msg_type: 0
  });
});

test("an authentication failure refreshes and retries exactly once", async () => {
  const tokenProvider = createTokenProvider();
  const fake = createMessageFetch([
    new Response(JSON.stringify({ code: 40101, message: "token invalid" }), { status: 401 }),
    new Response(JSON.stringify({ id: "message-after-refresh" }), { status: 200 })
  ]);
  const client = createQqClient({ fetch: fake.fetch, tokenProvider });

  assert.equal((await client.sendDirectMessage({ userOpenId: "user-openid", content: "hello" })).messageId, "message-after-refresh");
  assert.equal(tokenProvider.invalidations, 1);
  assert.deepEqual(tokenProvider.calls, [undefined, { force: true }]);
  assert.equal(fake.calls.length, 2);
  assert.equal(new Headers(fake.calls[1].init?.headers).get("authorization"), "QQBot fake-refreshed-token");
});

test("rate limits expose the server retry delay without retrying", async () => {
  const fake = createMessageFetch([
    new Response(JSON.stringify({ code: 42901, message: "slow down" }), {
      status: 429,
      headers: { "retry-after": "2" }
    })
  ]);
  const client = createQqClient({ fetch: fake.fetch, tokenProvider: createTokenProvider() });

  await assert.rejects(client.sendDirectMessage({ userOpenId: "user-openid", content: "hello" }), (error: unknown) => {
    assert.ok(error instanceof QqApiError);
    assert.equal(error.kind, "rate_limited");
    assert.equal(error.status, 429);
    assert.equal(error.code, "42901");
    assert.equal(error.retryAfterMs, 2000);
    return true;
  });
  assert.equal(fake.calls.length, 1);
});

test("server failures are transient and relationship or permission failures are permanent", async () => {
  const transient = createQqClient({
    fetch: createMessageFetch([new Response(JSON.stringify({ code: 50001 }), { status: 503 })]).fetch,
    tokenProvider: createTokenProvider()
  });
  await assert.rejects(transient.sendDirectMessage({ userOpenId: "user-openid", content: "hello" }), (error: unknown) => {
    assert.ok(error instanceof QqApiError);
    assert.equal(error.kind, "transient");
    assert.equal(error.status, 503);
    return true;
  });

  const relationship = createQqClient({
    fetch: createMessageFetch([
      new Response(JSON.stringify({ code: 40301, message: "not friends with this user" }), { status: 403 })
    ]).fetch,
    tokenProvider: createTokenProvider()
  });
  await assert.rejects(relationship.sendDirectMessage({ userOpenId: "user-openid", content: "hello" }), (error: unknown) => {
    assert.ok(error instanceof QqApiError);
    assert.equal(error.kind, "relationship");
    return true;
  });

  const permission = createQqClient({
    fetch: createMessageFetch([
      new Response(JSON.stringify({ code: 40302, message: "active message permission denied" }), { status: 403 })
    ]).fetch,
    tokenProvider: createTokenProvider()
  });
  await assert.rejects(permission.sendDirectMessage({ userOpenId: "user-openid", content: "hello" }), (error: unknown) => {
    assert.ok(error instanceof QqApiError);
    assert.equal(error.kind, "permission");
    return true;
  });
});
