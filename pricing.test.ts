import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import snapshot from "./pricing-data.json";
import {
  ModelPricing,
  PricingStore,
  parseLiteLLM,
  parseModelsDev,
  parseSupplement,
  type TokenUsage,
} from "./pricing";
import { aggregateHistory, createLogParser, HistoryCache } from "./history";
import { parseCursorHistory } from "./cursor-history";

const pricing = new ModelPricing(snapshot);
const tokens = (overrides: Partial<TokenUsage> = {}): TokenUsage => ({
  input: 1000,
  output: 100,
  cacheRead: 10000,
  cacheWrite: 0,
  cacheWrite1h: 0,
  ...overrides,
});
const now = Date.now();
const timestamp = new Date(now).toISOString();
const feed = {
  "test-model": {
    input_cost_per_token: 2e-6,
    output_cost_per_token: 10e-6,
    cache_read_input_token_cost: 0.1e-6,
  },
};

describe("API pricing", () => {
  it("prices GPT input, output and cached input separately at current catalog rates", () => {
    expect(pricing.estimate("gpt-6.1-sol", tokens())).toBeCloseTo(0.004);
    expect(pricing.estimate("openai/gpt-6.1-sol", tokens())).toBeCloseTo(0.004);
    expect(pricing.estimate("gpt-6.1-sol-2026-09-28", tokens())).toBeCloseTo(0.004);
    // The older OpenUsage supplement has 5/30 here; the current primary feed has 4/20.
    expect(pricing.estimate("gpt-5.6-sol", tokens({ cacheRead: 0 }))).toBeCloseTo(0.006);
  });
  it("applies request long-context and priority rates, without treating daily totals as a long request", () => {
    const usage = tokens({ input: 280000, cacheRead: 0, output: 1000 });
    expect(pricing.estimate("gpt-6.1-sol", usage)).toBeCloseTo(1.135);
    expect(pricing.estimate("gpt-6.1-sol", { ...usage, fast: true })).toBeCloseTo(2.27);
    expect(pricing.estimate("gpt-6.1-sol", usage, false)).toBeCloseTo(0.57);
    expect(pricing.estimate("gpt-6.1-sol", tokens({ input: 272000, cacheRead: 0 }))).toBeCloseTo(0.545);
  });
  it("prices five-minute and one-hour Claude cache writes separately", () => {
    expect(pricing.estimate("claude-opus-5-5", tokens({ cacheWrite: 1000, cacheWrite1h: 1000 }))).toBeCloseTo(
      0.021,
    );
    expect(
      pricing.estimate("claude-opus-5-5", tokens({ cacheWrite: 1000, cacheWrite1h: 1000, fast: true })),
    ).toBeCloseTo(0.042);
  });
  it("understands OpenUsage aliases, effort labels, Router labels and fast variants once", () => {
    expect(pricing.estimate("gpt-5.6-sol-high-fast", tokens())).toBeCloseTo(0.02);
    expect(pricing.estimate("gpt-5.6-sol-high-fast", tokens({ fast: true }))).toBeCloseTo(0.02);
    expect(pricing.estimate("Opus 5.5 Fast (Auto Balanced)", tokens())).toBeCloseTo(0.016);
    expect(pricing.estimate("default", tokens())).toBeCloseTo(0.00435);
    expect(pricing.estimate("composer-2.5-fast", tokens())).toBeCloseTo(0.0095);
  });
  it("keeps unknown models and malformed buckets unpriced", () => {
    expect(pricing.estimate("gpt-unknown-new-model", tokens())).toBeNull();
    expect(pricing.estimate("gpt-6.1-sol", tokens({ input: -1 }))).toBeNull();
    expect(pricing.estimate("gpt-6.1-sol", tokens({ output: NaN }))).toBeNull();
  });
  it("converts LiteLLM per-token and models.dev per-million prices, preserving full-input cache fallback", () => {
    expect(parseLiteLLM(feed)["test-model"].base).toMatchObject({
      input: 2,
      output: 10,
      cacheWrite: 2,
    });
    expect(parseLiteLLM(feed)["test-model"].base.cacheRead).toBeCloseTo(0.1);
    const models = parseModelsDev({
      reseller: { models: { test: { cost: { input: 100, output: 100 } } } },
      openai: {
        models: {
          test: {
            cost: {
              input: 2,
              output: 10,
              tiers: [
                {
                  tier: { type: "context", size: 200000 },
                  input: 4,
                  output: 15,
                },
              ],
            },
          },
        },
      },
    });
    expect(models.test).toMatchObject({
      base: { input: 2, output: 10, cacheRead: 2 },
      long: { input: 4, threshold: 200000 },
    });
    expect(
      parseSupplement({
        pricing: { custom: { input_per_million: 1, output_per_million: 5 } },
      }).supplement.custom.base.cacheRead,
    ).toBe(1);
    expect(() => parseLiteLLM({})).toThrow();
    expect(() => parseModelsDev({})).toThrow();
  });
  it("uses bundled prices offline, deduplicates refreshes and sends no account credentials to feeds", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("offline");
    });
    let time = now;
    const store = new PricingStore(fetcher as unknown as typeof fetch, undefined, undefined, () => time);
    const [first, second] = await Promise.all([store.current(), store.current()]);
    expect(first).toBe(second);
    expect(first.estimate("gpt-6.1-sol", tokens())).toBeCloseTo(0.004);
    expect(fetcher).toHaveBeenCalledTimes(3);
    await store.current();
    expect(fetcher).toHaveBeenCalledTimes(3);
    for (const [, options] of fetcher.mock.calls as unknown as [string, RequestInit][]) {
      expect(options.headers).toEqual({ Accept: "application/json" });
      expect(options.redirect).toBe("error");
    }
    time += 3600001;
    await store.current();
    expect(fetcher).toHaveBeenCalledTimes(6);
  });
  it("persists public prices and uses them after restart when feeds fail", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "subscription-pricing-"));
    const file = path.join(dir, "prices.json");
    try {
      const fetcher = vi.fn(
        async (url: string) =>
          new Response(
            JSON.stringify(
              url.includes("litellm")
                ? feed
                : url.includes("models.dev")
                  ? {
                      openai: {
                        models: { test: { cost: { input: 2, output: 10 } } },
                      },
                    }
                  : {
                      pricing: {
                        auto: { input_per_million: 1, output_per_million: 5 },
                      },
                    },
            ),
          ),
      );
      const store = new PricingStore(fetcher as unknown as typeof fetch, undefined, file, () => now + 1000);
      expect((await store.current()).estimate("test-model", tokens())).toBeCloseTo(0.004);
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
      const offline = new PricingStore(
        (async () => {
          throw new Error("offline");
        }) as typeof fetch,
        undefined,
        file,
      );
      expect((await offline.current()).estimate("test-model", tokens())).toBeCloseTo(0.004);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("history estimates", () => {
  it("prices Claude cache splits, deduplicates streaming records and preserves reported costs", () => {
    const parse = createLogParser("claude");
    const row = {
      timestamp,
      message: {
        id: "request",
        model: "claude-opus-5-5",
        usage: {
          input_tokens: 1000,
          output_tokens: 100,
          cache_read_input_tokens: 10000,
          cache_creation: {
            ephemeral_5m_input_tokens: 1000,
            ephemeral_1h_input_tokens: 1000,
          },
        },
      },
    };
    const events = parse(row);
    const history = aggregateHistory([...events, ...events], now, "local", false, pricing);
    expect(history.models[0]).toMatchObject({
      tokens: 13100,
      events: 1,
      costUsd: 0.021,
      estimated: true,
    });
    expect(
      aggregateHistory(parse({ ...row, costUSD: 0.67 }), now, "local", false, pricing).models[0],
    ).toMatchObject({ costUsd: 0.67 });
    expect(
      aggregateHistory(parse({ ...row, costUSD: 0.67 }), now, "local", false, pricing).models[0].estimated,
    ).toBeUndefined();
  });
  it("prices Codex cumulative deltas with cache reads and reasoning included once, and recorded fast tier", () => {
    const parse = createLogParser("codex");
    parse({ type: "turn_context", payload: { model: "gpt-6.1-sol" } });
    parse({
      type: "event_msg",
      payload: {
        type: "thread_settings_applied",
        thread_settings: { service_tier: "priority" },
      },
    });
    const row = (input: number, cached: number, output: number) => ({
      type: "event_msg",
      timestamp,
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: input,
            cached_input_tokens: cached,
            output_tokens: output,
            reasoning_output_tokens: 50,
            total_tokens: input + output,
          },
        },
      },
    });
    const first = parse(row(11000, 10000, 100));
    const second = parse(row(22000, 20000, 200));
    expect(parse(row(22000, 20000, 200))).toEqual([]);
    expect(aggregateHistory([...first, ...second], now, "local", false, pricing).models[0]).toMatchObject({
      tokens: 22200,
      events: 2,
      costUsd: 0.016,
      estimated: true,
    });
    // Separate token_count timestamps count two turns, even when their deltas match.
    const later = second.map((e) => ({ ...e, id: "second", at: now }));
    expect(
      aggregateHistory([...first, ...later], now, "local", false, pricing).models[0].costUsd,
    ).toBeCloseTo(0.016);
  });
  it("prices Grok inclusive cache tokens and output without double counting reasoning", () => {
    const parse = createLogParser("grok");
    const events = parse({
      params: {
        _meta: { agentTimestampMs: now },
        update: {
          sessionUpdate: "turn_completed",
          usage: {
            modelUsage: {
              "grok-4.5": {
                inputTokens: 11000,
                cachedReadTokens: 10000,
                cacheCreationTokens: 100,
                outputTokens: 100,
                reasoningTokens: 50,
              },
            },
          },
        },
      },
    });
    const result = aggregateHistory(events, now, "local", false, pricing).models[0];
    expect(result.tokens).toBe(11100);
    expect(result.costUsd).toBeCloseTo(0.0076);
    expect(result.estimated).toBe(true);
  });
  it("prices Cursor export buckets at base rates and shows unknown models separately", () => {
    const csv = `Date,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens\n${timestamp},gpt-6.1-sol,0,280000,0,1000\n${timestamp},unknown,0,500,0,10\n`;
    const result = parseCursorHistory(csv, now, pricing);
    expect(result.models[0]).toMatchObject({
      tokens: 281000,
      costUsd: 0.57,
      estimated: true,
    });
    expect(result.days.at(-1)).toMatchObject({
      tokens: 281510,
      costUsd: 0.57,
      estimated: true,
      unpricedTokens: 510,
    });
  });
  it("reprices unchanged cached files after prices refresh and returns only aggregates", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "subscription-estimates-"));
    let rates = pricing;
    const cache = new HistoryCache(
      vi.fn(),
      dir,
      {},
      () => now,
      async () => rates,
    );
    try {
      await fs.mkdir(path.join(dir, ".claude/projects/test"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(dir, ".claude/projects/test/session.jsonl"),
        JSON.stringify({
          timestamp,
          message: {
            id: "id",
            model: "test-model",
            content: "private conversation",
            usage: { input_tokens: 1000, output_tokens: 100 },
          },
        }) + "\n",
      );
      await cache.refresh("claude");
      expect(cache.get("claude").models[0].costUsd).toBeNull();
      rates = new ModelPricing({ ...snapshot, primary: parseLiteLLM(feed) });
      await cache.refresh("claude", true);
      expect(cache.get("claude").models[0].costUsd).toBeCloseTo(0.003);
      expect(JSON.stringify(cache.get("claude"))).not.toMatch(/private conversation|tokenUsage|input_tokens/);
    } finally {
      cache.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
