import { describe, expect, it } from "vitest";
import { quotaAccount, renderQuotas, renderQuotaSummary, summarizeQuotas, type QuotaAccount } from "./quotas";
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

describe("agent quota summary", () => {
  const HOUR = 3_600_000;
  const now = Date.parse("2026-10-24T12:00:00Z");
  const row = (label: string, used: number, resetIn: number, windowMs: number, scope?: QuotaAccount["limits"][number]["scope"]) => ({
    label, used, limit: 100, remaining: 100 - used, unit: "percent" as const, resetAt: now + resetIn, windowMs, lastKnownRemaining: null, ...(scope ? { scope } : {}),
  });
  const account = (name: string, active: boolean, limits: QuotaAccount["limits"], extra: Partial<QuotaAccount> = {}): QuotaAccount => ({
    provider: "claude", account: name, email: null, active, plan: "Max", status: "ready", checkedAt: now, retrievedAt: now, stale: false, error: null, limits, ...extra,
  });

  it("bounds a group by the account limit and projects runway from steady pace", () => {
    // Half the 5-hour window gone with 80% used: runs out before the reset.
    const hot = account("hot", true, [
      row("5-hour window", 80, 2.5 * HOUR, 5 * HOUR),
      row("Fable · weekly", 10, 100 * HOUR, 168 * HOUR, { kind: "group", group: "fable" }),
      row("Sonnet · weekly", 90, 100 * HOUR, 168 * HOUR, { kind: "group", group: "sonnet" }),
    ]);
    const { rows, attention } = summarizeQuotas({ now, accounts: [hot] });
    // Fable is held down by the account's 5-hour limit, so only the `all` row speaks for it.
    expect(rows).toMatchObject([
      { scope: "all", left: "20%", runway: "runs_out", runsOutAt: now + 2.5 * HOUR * (20 / 80), limitedBy: "5-hour window" },
      { scope: "group:sonnet", left: "10%", limitedBy: "Sonnet · weekly" },
    ]);
    expect(rows).toHaveLength(2);
    expect(attention[0]).toMatchObject({ account: "hot", next: "plan a switch before then" });
  });

  it("marks exhausted and low accounts, and picks the account with the most left", () => {
    const out = account("out", true, [row("Weekly window", 100, 30 * HOUR, 168 * HOUR)]);
    const low = account("low", false, [row("Weekly window", 95, 30 * HOUR, 168 * HOUR)]);
    const later = account("later", false, [row("Weekly window", 40, 90 * HOUR, 168 * HOUR)]);
    const sooner = account("sooner", false, [row("Weekly window", 42, 20 * HOUR, 168 * HOUR)]);
    const summary = summarizeQuotas({ now, accounts: [out, low, later, sooner] });
    expect(summary.rows.find((r) => r.account === "out")).toMatchObject({ runway: "out", resetsAt: now + 30 * HOUR });
    expect(summary.attention).toEqual([
      expect.objectContaining({ account: "out", issue: expect.stringContaining("all out until"), next: "bb subs use claude <another account>" }),
      expect.objectContaining({ account: "low", issue: "all almost out: 5% left (Weekly window)", next: "none" }),
    ]);
    // 60% and 58% are a near-tie, so the sooner reset wins: its quota would otherwise be lost.
    expect(summary.pick).toEqual([{ provider: "claude", account: "sooner", inUse: false, why: expect.stringMatching(/^58% left, resets /) }]);
  });

  it("keeps the account in use on a near-tie, so no thread moves for nothing", () => {
    const inUse = account("in-use", true, [row("Weekly window", 45, 90 * HOUR, 168 * HOUR)]);
    const other = account("other", false, [row("Weekly window", 42, 20 * HOUR, 168 * HOUR)]);
    expect(summarizeQuotas({ now, accounts: [other, inUse] }).pick).toMatchObject([{ account: "in-use", inUse: true }]);
  });

  it("keeps failed and old readings unknown and names the next step", () => {
    const lost = account("lost", false, [{ ...row("Weekly window", 30, HOUR, 168 * HOUR), remaining: null, lastKnownRemaining: 70 }], { status: "error", error: "Login expired. Sign in again." });
    const old = account("old", false, [], { stale: true, loading: true, status: "ready" });
    const text = renderQuotaSummary({ now, accounts: [lost, old] });
    expect(text).toContain('claude,lost,no,all,unknown (last 70%),unknown,');
    expect(text).toContain('claude,lost,"error: Login expired. Sign in again.",the owner logs in again on the Subscription Accounts page');
    expect(text).toContain("claude,old,new reading did not finish in time; last reading shown as unknown,bb subs quota claude --refresh");
    expect(text).toContain("pick[0]");
  });

  it("says so when no account is saved", () => {
    expect(renderQuotaSummary({ now, accounts: [] })).toContain("accounts: none saved");
  });
});
