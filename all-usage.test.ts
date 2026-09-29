import { describe, expect, it } from "vitest";
import { aggregateProviders, periodDates, sumUsage } from "./all-usage";
import type { UsageHistory } from "./usage-types";

const now = Date.parse("2026-09-29T00:30:00Z");
const history = (costUsd: number | null, tokens = 100, date = "2026-09-29"): UsageHistory => ({
  status: "ready",
  source: "local",
  days: [{ date, tokens, events: 1, costUsd }],
  models: [],
  fetchedAt: now,
  refreshing: false,
  partial: false,
  error: null,
});

describe("combined provider usage", () => {
  it("counts shared CLI history once and sums every Cursor account export", () => {
    const claude = history(1);
    const data = {
      history: { claude, codex: history(2), grok: history(3) },
      swap: [
        { id: "claude" as const, accounts: [{ usage: { history: claude } }, { usage: { history: claude } }] },
        {
          id: "cursor" as const,
          accounts: [{ usage: { history: history(4) } }, { usage: { history: history(5) } }],
        },
      ],
    };
    const providers = aggregateProviders(data, "today", now);
    expect(providers.find((p) => p.id === "claude")!.total.costUsd).toBe(1);
    expect(providers.find((p) => p.id === "cursor")!.total.costUsd).toBe(9);
    expect(sumUsage(providers.filter((p) => p.available).map((p) => p.total))).toMatchObject({
      costUsd: 15,
      tokens: 500,
      events: 5,
    });
    expect(providers.find((p) => p.id === "antigravity")!.available).toBe(false);
  });
  it("uses each source's timezone for today and yesterday", () => {
    const codex = { ...history(7, 100, "2026-09-28"), timeZone: "America/Los_Angeles" };
    expect(
      aggregateProviders({ history: { codex }, swap: [] }, "today", now).find((p) => p.id === "codex")!.total
        .costUsd,
    ).toBe(7);
    expect(periodDates(now, "yesterday", "America/Los_Angeles")).toEqual(["2026-09-27", "2026-09-27"]);
  });
  it("includes exactly 30 calendar days and excludes future records", () => {
    const codex = history(1);
    codex.days = ["2026-08-30", "2026-08-31", "2026-09-29", "2026-09-30"].map((date) => ({
      date,
      tokens: 10,
      events: 1,
      costUsd: 1,
    }));
    expect(
      aggregateProviders({ history: { codex }, swap: [] }, "30days", now).find((p) => p.id === "codex")!
        .total,
    ).toMatchObject({ costUsd: 2, tokens: 20 });
  });
  it("keeps missing prices out of cost while retaining their tokens and estimate flags", () => {
    expect(
      sumUsage([
        { tokens: 200, costUsd: null, events: 1 },
        { tokens: 100, costUsd: 4, events: 1, estimated: true },
      ]),
    ).toMatchObject({ costUsd: 4, tokens: 300, unpricedTokens: 200, estimated: true });
    expect(sumUsage([{ tokens: 200, costUsd: null, events: 1 }]).costUsd).toBeNull();
    expect(sumUsage([]).costUsd).toBe(0);
  });
  it("distinguishes unavailable, loading and empty ready sources", () => {
    const ready = { ...history(0), days: [] };
    const providers = aggregateProviders(
      {
        swap: [],
        history: {
          claude: ready,
          codex: { ...ready, status: "loading" },
          grok: { ...ready, status: "error" },
        },
      },
      "today",
      now,
    );
    expect(providers.find((p) => p.id === "claude")).toMatchObject({
      available: true,
      total: { costUsd: 0 },
    });
    expect(providers.find((p) => p.id === "codex")).toMatchObject({ available: false, loading: true });
    expect(providers.find((p) => p.id === "grok")).toMatchObject({ available: false });
  });
  it("flags stale readings and incomplete Cursor coverage", () => {
    const providers = aggregateProviders(
      {
        history: { codex: { ...history(3), status: "error" } },
        swap: [{ id: "cursor", accounts: [{ usage: { history: history(4) } }, { usage: {} }] }],
      },
      "today",
      now,
    );
    expect(providers.find((p) => p.id === "codex")).toMatchObject({ available: true, stale: true });
    expect(providers.find((p) => p.id === "cursor")).toMatchObject({
      available: true,
      partial: true,
      total: { costUsd: 4 },
    });
  });
  it("surfaces the scanner's separately excluded unpriceable models", () => {
    const codex = { ...history(3), unpricedTokens: 500 };
    expect(
      aggregateProviders({ swap: [], history: { codex } }, "today", now).find((p) => p.id === "codex"),
    ).toMatchObject({ partial: true, excludedUnpricedTokens: 500, total: { costUsd: 3, tokens: 100 } });
  });
});
