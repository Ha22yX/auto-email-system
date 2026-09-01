import type { AiBillingProvider, AiCostAmount } from "./types";

type CostProvider = Exclude<AiBillingProvider, "none">;

type QueryProviderCostsInput = {
  provider: CostProvider;
  adminKey: string;
  startAt: string;
  endAt: string;
  fetchImpl?: typeof fetch;
};

function addAmount(amounts: Map<string, number>, currency: unknown, value: unknown) {
  const normalizedCurrency = typeof currency === "string" && currency.trim()
    ? currency.trim().toUpperCase()
    : "USD";
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return;
  amounts.set(normalizedCurrency, (amounts.get(normalizedCurrency) ?? 0) + parsed);
}

async function fetchCostPage(fetchImpl: typeof fetch, url: URL, init: RequestInit, providerLabel: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const detail = (await response.text()).replace(/\s+/g, " ").trim();
      throw new Error(`${providerLabel} 账单接口返回 ${response.status}: ${detail.slice(0, 240)}`);
    }
    return await response.json() as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`${providerLabel} 账单接口请求超时。`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function queryOpenAiCosts(input: QueryProviderCostsInput) {
  const amounts = new Map<string, number>();
  let page: string | undefined;

  for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
    const url = new URL("https://api.openai.com/v1/organization/costs");
    url.searchParams.set("start_time", String(Math.floor(Date.parse(input.startAt) / 1000)));
    url.searchParams.set("end_time", String(Math.ceil(Date.parse(input.endAt) / 1000)));
    url.searchParams.set("bucket_width", "1d");
    url.searchParams.set("limit", "180");
    if (page) url.searchParams.set("page", page);

    const payload = await fetchCostPage(input.fetchImpl ?? fetch, url, {
      headers: {
        Authorization: `Bearer ${input.adminKey}`,
        "Content-Type": "application/json"
      }
    }, "OpenAI");
    const buckets = Array.isArray(payload.data) ? payload.data : [];
    for (const bucket of buckets) {
      if (!bucket || typeof bucket !== "object") continue;
      const results = Array.isArray((bucket as { results?: unknown }).results)
        ? (bucket as { results: unknown[] }).results
        : [];
      for (const result of results) {
        if (!result || typeof result !== "object") continue;
        const amount = (result as { amount?: unknown }).amount;
        if (!amount || typeof amount !== "object") continue;
        addAmount(
          amounts,
          (amount as { currency?: unknown }).currency,
          (amount as { value?: unknown }).value
        );
      }
    }

    const nextPage = typeof payload.next_page === "string" ? payload.next_page : undefined;
    if (!payload.has_more || !nextPage) break;
    page = nextPage;
  }
  return amounts;
}

async function queryAnthropicCosts(input: QueryProviderCostsInput) {
  const amounts = new Map<string, number>();
  let page: string | undefined;

  for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
    const url = new URL("https://api.anthropic.com/v1/organizations/cost_report");
    url.searchParams.set("starting_at", input.startAt);
    url.searchParams.set("ending_at", input.endAt);
    url.searchParams.set("bucket_width", "1d");
    url.searchParams.set("limit", "31");
    if (page) url.searchParams.set("page", page);

    const payload = await fetchCostPage(input.fetchImpl ?? fetch, url, {
      headers: {
        "x-api-key": input.adminKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"
      }
    }, "Anthropic");
    const buckets = Array.isArray(payload.data) ? payload.data : [];
    for (const bucket of buckets) {
      if (!bucket || typeof bucket !== "object") continue;
      const results = Array.isArray((bucket as { results?: unknown }).results)
        ? (bucket as { results: unknown[] }).results
        : [];
      for (const result of results) {
        if (!result || typeof result !== "object") continue;
        addAmount(
          amounts,
          (result as { currency?: unknown }).currency,
          (result as { amount?: unknown }).amount
        );
      }
    }

    const nextPage = typeof payload.next_page === "string" ? payload.next_page : undefined;
    if (!payload.has_more || !nextPage) break;
    page = nextPage;
  }
  return amounts;
}

export async function queryProviderCosts(input: QueryProviderCostsInput): Promise<AiCostAmount[]> {
  if (!input.adminKey.trim()) throw new Error("请先保存账单管理员密钥。");
  if (!Number.isFinite(Date.parse(input.startAt)) || !Number.isFinite(Date.parse(input.endAt))) {
    throw new Error("账单查询时间范围无效。");
  }
  if (Date.parse(input.startAt) >= Date.parse(input.endAt)) {
    throw new Error("账单查询开始时间必须早于结束时间。");
  }

  const amounts = input.provider === "openai"
    ? await queryOpenAiCosts(input)
    : await queryAnthropicCosts(input);
  return [...amounts.entries()]
    .map(([currency, amount]) => ({ currency, amount: Number(amount.toFixed(8)) }))
    .sort((left, right) => left.currency.localeCompare(right.currency));
}
