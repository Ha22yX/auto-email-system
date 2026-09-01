import assert from "node:assert/strict";
import test from "node:test";
import { queryProviderCosts } from "./ai-costs";

test("queries and paginates OpenAI organization costs", async () => {
  const requests: Array<{ url: URL; authorization: string | null }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    const secondPage = url.searchParams.get("page") === "next-openai-page";
    return new Response(JSON.stringify({
      data: [{
        results: [{ amount: { currency: "usd", value: secondPage ? 0.25 : 1.5 } }]
      }],
      has_more: !secondPage,
      next_page: secondPage ? null : "next-openai-page"
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  const amounts = await queryProviderCosts({
    provider: "openai",
    adminKey: "openai-admin-key",
    startAt: "2026-09-01T00:00:00.000Z",
    endAt: "2026-09-02T00:00:00.000Z",
    fetchImpl
  });

  assert.deepEqual(amounts, [{ currency: "USD", amount: 1.75 }]);
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.url.origin, "https://api.openai.com");
  assert.equal(requests[0]?.url.pathname, "/v1/organization/costs");
  assert.equal(requests[0]?.authorization, "Bearer openai-admin-key");
  assert.equal(requests[1]?.url.searchParams.get("page"), "next-openai-page");
});

test("queries Anthropic organization costs with an admin key", async () => {
  const requests: Array<{ url: URL; headers: Headers }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: new URL(String(input)), headers: new Headers(init?.headers) });
    return new Response(JSON.stringify({
      data: [{
        results: [
          { currency: "USD", amount: "0.12345" },
          { currency: "USD", amount: "0.10000" }
        ]
      }],
      has_more: false,
      next_page: null
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  const amounts = await queryProviderCosts({
    provider: "anthropic",
    adminKey: "anthropic-admin-key",
    startAt: "2026-09-01T00:00:00.000Z",
    endAt: "2026-09-02T00:00:00.000Z",
    fetchImpl
  });

  assert.deepEqual(amounts, [{ currency: "USD", amount: 0.22345 }]);
  assert.equal(requests[0]?.url.origin, "https://api.anthropic.com");
  assert.equal(requests[0]?.url.pathname, "/v1/organizations/cost_report");
  assert.equal(requests[0]?.headers.get("x-api-key"), "anthropic-admin-key");
  assert.equal(requests[0]?.headers.get("anthropic-version"), "2023-06-01");
});

test("rejects invalid cost windows before calling a provider", async () => {
  await assert.rejects(
    queryProviderCosts({
      provider: "openai",
      adminKey: "admin-key",
      startAt: "2026-09-02T00:00:00.000Z",
      endAt: "2026-09-01T00:00:00.000Z"
    }),
    /开始时间必须早于结束时间/
  );
});
