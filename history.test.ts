import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { aggregateHistory, createLogParser, dateKey, HistoryCache, type UsageEvent } from "./history";
import { parseCursorHistory, fetchCursorHistory } from "./cursor-history";
import { quotaPace } from "./usage-types";
import { mapClaude, mapCodex, UsageCache } from "./usage";

const now = new Date(2026, 8, 29, 12).getTime();
const at = new Date(now).toISOString();
const event = (overrides: Partial<UsageEvent> = {}): UsageEvent => ({
  id: null,
  at: now,
  tokens: 100,
  model: "test-model",
  costUsd: null,
  ...overrides,
});
const claude = (id: string, tokens: number, timestamp = at) => ({
  type: "assistant",
  timestamp,
  requestId: "request",
  message: {
    id,
    model: "claude-fable-5",
    usage: {
      input_tokens: tokens,
      output_tokens: 10,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 5,
    },
  },
});
const codex = (total: number, last?: number, timestamp = at) => ({
  timestamp,
  type: "event_msg",
  payload: {
    type: "token_count",
    info: {
      total_token_usage: {
        input_tokens: total,
        output_tokens: 0,
        total_tokens: total,
      },
      ...(last !== undefined ? { last_token_usage: { input_tokens: last, total_tokens: last } } : {}),
    },
  },
});

describe("usage history", () => {
  it("keeps 30 calendar days, excludes old/future data, deduplicates copies and retains unknown costs", () => {
    const history = aggregateHistory(
      [
        event({ id: "copy", tokens: 100 }),
        event({ id: "copy", tokens: 90 }),
        event({ at: now - 86_400_000, costUsd: 0.67 }),
        event({ at: now - 40 * 86_400_000 }),
        event({ at: now + 1 }),
      ],
      now,
    );
    expect(history.days).toHaveLength(30);
    expect(history.days.at(-1)).toMatchObject({
      date: dateKey(now),
      tokens: 100,
      costUsd: null,
      events: 1,
    });
    expect(history.days.at(-2)).toMatchObject({ tokens: 100, costUsd: 0.67 });
    expect(history.models[0]).toMatchObject({
      tokens: 200,
      costUsd: 0.67,
      events: 2,
      unpricedTokens: 100,
    });
    expect(aggregateHistory([], now)).toMatchObject({
      status: "unavailable",
      days: [],
    });
  });
  it("counts Claude cache tokens once and retains the richest streaming snapshot", () => {
    const parse = createLogParser("claude");
    const history = aggregateHistory(
      [
        ...parse(claude("message", 10)),
        ...parse(claude("message", 30)),
        ...parse({ ...claude("error", 100), message: { usage: { input_tokens: null, output_tokens: 10 } } }),
      ],
      now,
    );
    expect(history.models).toMatchObject([{ model: "claude-fable-5", tokens: 65, events: 1, costUsd: null }]);
    expect(JSON.stringify(history)).not.toContain("request");
  });
  it("counts Codex turn deltas, ignores repeated totals and does not add cached/reasoning tokens again", () => {
    const parse = createLogParser("codex");
    parse({ type: "turn_context", payload: { model: "gpt-test" } });
    const events = [
      ...parse(codex(100, 100)),
      ...parse(codex(100, 100)),
      ...parse(codex(150, undefined, new Date(now + 1).toISOString())),
    ];
    expect(events.map((e) => e.tokens)).toEqual([100, 50]);
    expect(events[0].model).toBe("gpt-test");
  });
  it("excludes parent history replayed into a Codex child, but seeds totals for its live turn", () => {
    const parse = createLogParser("codex");
    parse({
      type: "session_meta",
      timestamp: at,
      payload: { forked_from_id: "parent" },
    });
    expect(parse(codex(100, 100))).toEqual([]);
    parse({
      type: "event_msg",
      timestamp: at,
      payload: { type: "task_started", started_at: now / 1000 - 10 },
    });
    expect(parse(codex(120, 20))).toEqual([]);
    parse({
      type: "event_msg",
      timestamp: at,
      payload: { type: "task_started", started_at: now / 1000 },
    });
    expect(parse(codex(150))).toMatchObject([{ tokens: 30 }]);
  });
  it("reads Grok durable completed-turn usage and provider-reported tick costs", () => {
    const parse = createLogParser("grok");
    const events = parse({
      params: {
        _meta: { eventId: "event", agentTimestampMs: now },
        update: {
          sessionUpdate: "turn_completed",
          usage: {
            costUsdTicks: 6_700_000_000,
            modelUsage: {
              grok: {
                inputTokens: 100,
                cachedReadTokens: 50,
                outputTokens: 10,
                reasoningTokens: 5,
              },
            },
          },
        },
      },
    });
    expect(events).toMatchObject([{ tokens: 110, costUsd: 0.67 }]);
    expect(aggregateHistory([...events, ...events], now).days.at(-1)?.tokens).toBe(110);
    expect(parse({ update: { sessionUpdate: "message" } })).toEqual([]);
  });
  it("caches unchanged files, reads appended records, clears deleted files and exposes only usage", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "subscription-history-"));
    const cache = new HistoryCache(vi.fn(), home, {}, () => now);
    try {
      const dir = path.join(home, ".claude/projects/test");
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, "session.jsonl");
      await fs.writeFile(
        file,
        JSON.stringify({
          ...claude("first", 10),
          privateText: "private-conversation",
        }) + "\n",
      );
      await cache.refresh("claude");
      expect(cache.get("claude").days.at(-1)?.tokens).toBe(45);
      await fs.appendFile(file, JSON.stringify(claude("second", 20)) + "\n");
      await Promise.all([cache.refresh("claude", true), cache.refresh("claude", true)]);
      expect(cache.get("claude").days.at(-1)?.tokens).toBe(100);
      expect(JSON.stringify(cache.get("claude"))).not.toContain("private-conversation");
      await fs.unlink(file);
      await cache.refresh("claude", true);
      expect(cache.get("claude")).toMatchObject({
        status: "unavailable",
        days: [],
      });
    } finally {
      cache.dispose();
      await fs.rm(home, { recursive: true, force: true });
    }
  });
  it("handles Cursor quoted cells, thousands separators and malformed rows without invented costs", () => {
    const csv = `Date,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens\r\n${at},"test, model",10,"1,000",30,40\r\nbad-date,test,0,0,0,0\r\n`;
    expect(parseCursorHistory(csv, now)).toMatchObject({
      status: "ready",
      partial: true,
      models: [{ model: "test, model", tokens: 1080, costUsd: null }],
    });
    expect(() => parseCursorHistory("Date,Model\n")).toThrow();
    expect(() => parseCursorHistory(csv + '"unterminated')).toThrow();
  });
  it("separates Cursor export failures from quota results and hides credential-bearing errors", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("secret-cookie");
    }) as unknown as typeof fetch;
    expect(await fetchCursorHistory(fetcher, "secret-cookie")).toMatchObject({
      status: "error",
      error: "Could not load Cursor’s usage export. Refresh to retry.",
    });
  });
  it("preserves Cursor history when the next export fails", async () => {
    const cache = new UsageCache(vi.fn(), () => now);
    const history = aggregateHistory([event()], now, "cursor");
    await cache.refresh("cursor", async () => ({
      plan: "Pro",
      metrics: [],
      history,
    }));
    await cache.refresh(
      "cursor",
      async () => ({
        plan: "Pro",
        metrics: [],
        history: {
          ...history,
          status: "error",
          days: [],
          models: [],
          error: "Failed",
        },
      }),
      true,
    );
    expect(cache.get("cursor").history).toMatchObject({
      status: "error",
      days: history.days,
    });
  });
  it("shows Claude model-specific limits and Codex extra rate limits", () => {
    expect(mapClaude({ seven_day_fable: { utilization: 57, resets_at: at } }).metrics).toMatchObject([
      { label: "Fable · weekly", used: 57, windowMs: 604_800_000 },
    ]);
    expect(
      mapCodex({
        additional_rate_limits: [
          {
            limit_name: "Fast models",
            rate_limit: {
              primary_window: {
                used_percent: 42,
                limit_window_seconds: 18000,
                reset_at: now / 1000,
              },
            },
          },
        ],
      }).metrics,
    ).toMatchObject([{ label: "Fast models · session", used: 42, windowMs: 18_000_000 }]);
  });
  it("predicts pace only inside a known window with enough elapsed time", () => {
    const row = {
      label: "Weekly",
      used: 87,
      limit: 100,
      remaining: 13,
      unit: "percent" as const,
      resetAt: now + 2 * 86_400_000,
      windowMs: 7 * 86_400_000,
    };
    expect(quotaPace(row, now)?.limitIn).toBeCloseTo((5 * 86_400_000 * 13) / 87);
    expect(quotaPace({ ...row, windowMs: undefined }, now)).toBeNull();
    expect(quotaPace({ ...row, resetAt: now - 1 }, now)).toBeNull();
    expect(quotaPace({ ...row, resetAt: now + row.windowMs - 60_000 }, now)).toBeNull();
  });
});
