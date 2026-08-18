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
  assert.deepEqual(JSON.parse(String(fake.calls[0].init?.body)), { content: "hello", msg_type: 0, msg_seq: 1 });
});

test("passive direct messages include the incoming msg_id", async () => {
  const tokenProvider = createTokenProvider();
  const fake = createMessageFetch([new Response(JSON.stringify({ id: "message-2" }), { status: 200 })]);
  const client = createQqClient({ fetch: fake.fetch, tokenProvider });

  await client.sendDirectMessage({ userOpenId: "user-openid", content: "bound", msgId: "incoming-message-id" });
  assert.deepEqual(JSON.parse(String(fake.calls[0].init?.body)), {
    content: "bound",
    msg_id: "incoming-message-id",
    msg_type: 0,
    msg_seq: 1
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

test("5xx responses use the conservative transient fallback", async () => {
  const client = createQqClient({
    fetch: createMessageFetch([new Response(JSON.stringify({ err_code: 12003 }), { status: 503 })]).fetch,
    tokenProvider: createTokenProvider()
  });

  await assert.rejects(client.sendDirectMessage({ userOpenId: "user-openid", content: "hello" }), (error: unknown) => {
    assert.ok(error instanceof QqApiError);
    assert.equal(error.kind, "transient");
    assert.equal(error.status, 503);
    return true;
  });
});
test("a second authentication failure is surfaced without another refresh or message request", async () => {
  const tokenProvider = createTokenProvider();
  const fake = createMessageFetch([
    new Response(JSON.stringify({ err_code: 11243 }), { status: 401 }),
    new Response(JSON.stringify({ err_code: 11243 }), { status: 401 }),
    new Response(JSON.stringify({ id: "must-not-be-sent" }), { status: 200 })
  ]);
  const client = createQqClient({ fetch: fake.fetch, tokenProvider });

  await assert.rejects(client.sendDirectMessage({ userOpenId: "user-openid", content: "hello" }), (error: unknown) => {
    assert.ok(error instanceof QqApiError);
    assert.equal(error.kind, "authentication");
    return true;
  });
  assert.equal(tokenProvider.invalidations, 1);
  assert.deepEqual(tokenProvider.calls, [undefined, { force: true }]);
  assert.equal(fake.calls.length, 2);
});

test("documented QQ err_code mappings take precedence and unknown account errors use conservative fallback", async () => {
  const fixtures: Array<{ errCode: number; status: number; kind: QqApiError["kind"] }> = [
    { errCode: 11252, status: 400, kind: "transient" },
    { errCode: 11253, status: 503, kind: "permission" },
    { errCode: 11254, status: 403, kind: "permission" },
    { errCode: 10001, status: 400, kind: "invalid_request" }
  ];

  for (const fixture of fixtures) {
    const client = createQqClient({
      fetch: createMessageFetch([new Response(JSON.stringify({ err_code: fixture.errCode }), { status: fixture.status })]).fetch,
      tokenProvider: createTokenProvider()
    });
    await assert.rejects(client.sendDirectMessage({ userOpenId: "user-openid", content: "hello" }), (error: unknown) => {
      assert.ok(error instanceof QqApiError);
      assert.equal(error.kind, fixture.kind);
      assert.equal(error.code, String(fixture.errCode));
      return true;
    });
  }

  const notFound = createQqClient({
    fetch: createMessageFetch([new Response(JSON.stringify({ err_code: 12003 }), { status: 404 })]).fetch,
    tokenProvider: createTokenProvider()
  });
  await assert.rejects(notFound.sendDirectMessage({ userOpenId: "user-openid", content: "hello" }), (error: unknown) => {
    assert.ok(error instanceof QqApiError);
    assert.equal(error.kind, "invalid_request");
    return true;
  });
});

test("a delayed 401 for token A does not discard a refreshed token B", async () => {
  const { createTokenProvider: createRealTokenProvider } = await import("./credentials");
  const tokens = [
    { access_token: "fake-token-a", expires_in: "7200" },
    { access_token: "fake-token-b", expires_in: "7200" }
  ];
  let tokenRequests = 0;
  const tokenProvider = createRealTokenProvider({
    fetch: async () => {
      tokenRequests += 1;
      const body = tokens.shift();
      if (!body) throw new Error("unexpected token request");
      return new Response(JSON.stringify(body), { status: 200 });
    },
    readConfig: () => ({
      appId: "test-app-id",
      encryptedAppSecret: "encrypted-test-secret",
      enabled: true,
      quoteImageMarksRead: true,
  notifyCategories: { important: true, secondary: true, ignore: false }
    }),
    decryptCredential: () => "fake-app-secret"
  });
  const messageCalls: Array<{ init?: RequestInit }> = [];
  const pending: Array<(response: Response) => void> = [];
  const client = createQqClient({
    tokenProvider,
    fetch: async (_url, init) => {
      messageCalls.push({ init });
      if (messageCalls.length <= 2) return new Promise<Response>((resolve) => pending.push(resolve));
      return new Response(JSON.stringify({ id: `message-${messageCalls.length}` }), { status: 200 });
    }
  });

  const first = client.sendDirectMessage({ userOpenId: "user-openid", content: "first" });
  const second = client.sendDirectMessage({ userOpenId: "user-openid", content: "second" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 2);

  pending[0](new Response(JSON.stringify({ err_code: 11243 }), { status: 401 }));
  await first;
  pending[1](new Response(JSON.stringify({ err_code: 11243 }), { status: 401 }));
  await second;

  assert.equal(tokenRequests, 2);
  assert.deepEqual(
    messageCalls.map((call) => new Headers(call.init?.headers).get("authorization")),
    ["QQBot fake-token-a", "QQBot fake-token-a", "QQBot fake-token-b", "QQBot fake-token-b"]
  );
});

test("direct images use the official rich-media upload and media message flow", async () => {
  const image = Buffer.from("png-card");
  const fake = createMessageFetch([
    new Response(JSON.stringify({ file_info: "uploaded-file-reference" }), { status: 200 }),
    new Response(JSON.stringify({
      id: "image-message",
      ext_info: { ref_idx: "REFIDX_IMAGE" }
    }), { status: 200 })
  ]);
  const client = createQqClient({ fetch: fake.fetch, tokenProvider: createTokenProvider() });

  assert.deepEqual(await client.sendDirectImage({
    userOpenId: "user-openid",
    image,
    fileName: "mail-summary.png"
  }), { messageId: "image-message", refIndex: "REFIDX_IMAGE" });

  assert.equal(fake.calls[0].url, "https://api.bot.qq.com/v2/users/user-openid/files");
  assert.deepEqual(JSON.parse(String(fake.calls[0].init?.body)), {
    file_type: 1,
    file_data: image.toString("base64"),
    file_name: "mail-summary.png",
    srv_send_msg: false
  });
  assert.equal(fake.calls[1].url, "https://api.bot.qq.com/v2/users/user-openid/messages");
  assert.deepEqual(JSON.parse(String(fake.calls[1].init?.body)), {
    msg_type: 7,
    msg_seq: 1,
    media: { file_info: "uploaded-file-reference" }

  });
});

test("Markdown images and read buttons share one QQ message payload", async () => {
  const fake = createMessageFetch([
    new Response(JSON.stringify({ id: "markdown-message", ext_info: { ref_idx: "REFIDX_MARKDOWN" } }), { status: 200 })
  ]);
  const client = createQqClient({ fetch: fake.fetch, tokenProvider: createTokenProvider() });

  assert.deepEqual(await client.sendDirectMarkdownImage({
    userOpenId: "user-openid",
    imageUrl: "https://mail.example.com/api/qq-assets/card.png?expires=1790000000&signature=signed",
    imageWidth: 1080,
    imageHeight: 1366,
    readActionToken: "a".repeat(32)
  }), { messageId: "markdown-message", refIndex: "REFIDX_MARKDOWN" });

  assert.deepEqual(JSON.parse(String(fake.calls[0].init?.body)), {
    markdown: {
      content: "![邮件通知 #1080px #1366px](https://mail.example.com/api/qq-assets/card.png?expires=1790000000&signature=signed)"
    },
    msg_type: 2,
    msg_seq: 1,
    keyboard: {
      content: {
        rows: [{
          buttons: [{
            id: "mail-read",
            render_data: { label: "标记为已阅", visited_label: "已标记为已阅", style: 1 },
            action: {
              type: 1,
              permission: { type: 2 },
              data: `mail-read:${"a".repeat(32)}`,
              click_limit: 1
            },
            group_id: "mail-read"
          }]
        }]
      }
    }
  });
});

test("interaction ACK uses PUT and confirmations can reference the original image", async () => {
  const fake = createMessageFetch([
    new Response(null, { status: 204 }),
    new Response(JSON.stringify({ id: "confirmation-message" }), { status: 200 })
  ]);
  const client = createQqClient({ fetch: fake.fetch, tokenProvider: createTokenProvider() });

  await client.acknowledgeInteraction("interaction-1");
  await client.sendDirectMessage({
    userOpenId: "user-openid",
    content: "已标记为系统已读。",
    messageReferenceId: "image-message"
  });

  assert.equal(fake.calls[0].url, "https://api.bot.qq.com/interactions/interaction-1");
  assert.equal(fake.calls[0].init?.method, "PUT");
  assert.deepEqual(JSON.parse(String(fake.calls[0].init?.body)), { code: 0 });
  assert.deepEqual(JSON.parse(String(fake.calls[1].init?.body)), {
    content: "已标记为系统已读。",
    msg_type: 0,
    msg_seq: 1,
    message_reference: { message_id: "image-message" }
  });
});

test("direct image validation rejects empty and oversized payloads before requesting QQ", async () => {
  const fake = createMessageFetch([]);
  const client = createQqClient({ fetch: fake.fetch, tokenProvider: createTokenProvider() });

  await assert.rejects(
    client.sendDirectImage({ userOpenId: "user-openid", image: Buffer.alloc(0) }),
    (error: unknown) => error instanceof QqApiError && error.code === "invalid_image_input"
  );
  await assert.rejects(
    client.sendDirectImage({ userOpenId: "user-openid", image: Buffer.alloc(5 * 1024 * 1024 + 1) }),
    (error: unknown) => error instanceof QqApiError && error.code === "invalid_image_input"
  );
  assert.equal(fake.calls.length, 0);
});
