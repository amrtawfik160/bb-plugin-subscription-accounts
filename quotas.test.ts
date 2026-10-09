import { describe, expect, it } from "vitest";
import { quotaAccount, renderQuotas } from "./quotas";
import { emptyUsage, mapAntigravityModelQuotas, mapClaude, mapCodex, mapCursor, USAGE_TTL_MS } from "./usage";

const target = { provider: "antigravity", account: "main", email: "main@example.com", active: true } as const;

describe("quota report", () => {
  it("keeps exact model fractions separate from shared plan quota", () => {
    const modelQuotas = mapAntigravityModelQuotas({ models: {
      pro: { displayName: "Gemini Pro", quotaInfo: { remainingFraction: 0.25, resetTime: "2026-09-30T12:00:00Z" } },
      flash: { displayName: "Gemini Flash", quotaInfo: {} },
      hidden: { isInternal: true, quotaInfo: { remainingFraction: 1 } },
    } });
    const account = quotaAccount(target, { ...emptyUsage(), status: "ready", plan: "Pro", fetchedAt: 1000, attemptedAt: 900, modelQuotas }, 1100);
    expect(account.limits).toEqual([{
      label: "Gemini Pro", used: null, limit: 100, remaining: 25, unit: "percent",
      resetAt: Date.parse("2026-09-30T12:00:00Z"), scope: { kind: "model", model: "pro" }, lastKnownRemaining: null,
    }]);
    const output = renderQuotas({ now: 1100, accounts: [account] });
    expect(output).toContain("Gemini Pro [model pro]: 25 percent left.");
    expect(output).toContain("Plan: Pro. Status: ready.");
    expect(output).not.toContain("available models");
  });

  it.each(["error", "stale"])("reports %s quota as unknown with a dated last known reading", (condition) => {
    const usage = { ...emptyUsage(), ...mapClaude({ five_hour: { utilization: 70 } }), status: condition === "error" ? "error" as const : "ready" as const, fetchedAt: 1000, attemptedAt: 1100 };
    const now = condition === "stale" ? 1000 + USAGE_TTL_MS : 1100;
    const account = quotaAccount(target, usage, now);
    expect(account.limits[0]).toMatchObject({ remaining: null, lastKnownRemaining: 30 });
    expect(account.retrievedAt).toBe(1000);
    expect(renderQuotas({ now, accounts: [account] })).toContain("unknown left. Reset: unknown. Last known: 30 percent.");
  });

  it("labels Claude model groups and Codex metered features without inventing a model", () => {
    expect(mapClaude({ seven_day_sonnet: { utilization: 20 } }).metrics[0]).toMatchObject({ remaining: 80, scope: { kind: "group", group: "sonnet" } });
    expect(mapCodex({ additional_rate_limits: [{ limit_name: "review", rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } } }] }).metrics[0]).toMatchObject({ remaining: 90, scope: { kind: "feature", feature: "review" } });
  });

  it("keeps Cursor pool percentages as current group remaining for ready readings", () => {
    const usage = {
      ...emptyUsage(),
      ...mapCursor({ planUsage: { autoPercentUsed: 40, apiPercentUsed: 25 } }),
      status: "ready" as const,
      fetchedAt: 1000,
      attemptedAt: 1000,
    };
    const account = quotaAccount({ provider: "cursor", account: "work", email: null, active: true }, usage, 1100);
    expect(account.limits).toEqual([
      {
        label: "Cursor models",
        used: 40,
        limit: 100,
        remaining: 60,
        unit: "percent",
        resetAt: null,
        scope: { kind: "group", group: "Cursor models" },
        lastKnownRemaining: null,
      },
      {
        label: "Other models",
        used: 25,
        limit: 100,
        remaining: 75,
        unit: "percent",
        resetAt: null,
        scope: { kind: "group", group: "Other models" },
        lastKnownRemaining: null,
      },
    ]);
    const output = renderQuotas({ now: 1100, accounts: [account] });
    expect(output).toContain("Cursor models [group Cursor models]: 60 percent left.");
    expect(output).toContain("Other models [group Other models]: 75 percent left.");
    expect(output).not.toMatch(/available models|catalogs/i);
  });
});
