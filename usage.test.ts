import { describe, expect, it, vi } from "vitest";
import {
  mapAntigravity,
  mapClaude,
  mapCodex,
  mapCursor,
  mapGrok,
  UsageCache,
  UsageError,
  USAGE_TTL_MS,
} from "./usage";
import { createUsageClient } from "./usage-client";

describe("provider quota normalization", () => {
  it("keeps Antigravity shared pools distinct and skips missing quotas", () => {
    const rows = mapAntigravity({
      groups: [
        {
          buckets: [
            {
              bucketId: "gemini-5h",
              remainingFraction: 0.25,
              resetTime: "2026-09-30T12:00:00Z",
            },
            { bucketId: "gemini-weekly", remainingFraction: 0 },
            { bucketId: "3p-5h" },
            { bucketId: "gemini-image-5h", remainingFraction: 0.5 },
          ],
        },
      ],
    });
    expect(rows.map((r) => [r.label, r.used, r.remaining])).toEqual([
      ["Gemini · 5 hours", 75, 25],
      ["Gemini · weekly", 100, 0],
    ]);
    expect(rows[0].resetAt).toBe(Date.parse("2026-09-30T12:00:00Z"));
    expect(
      mapAntigravity(
        { groups: [] },
        {
          models: {
            gemini: {
              displayName: "Gemini",
              quotaInfo: { remainingFraction: 0 },
            },
          },
        },
      ),
    ).toEqual([]);
  });

  it("merges legacy Gemini models using the most used quota without inventing weekly data", () => {
    expect(
      mapAntigravity(null, {
        models: {
          pro: {
            displayName: "Gemini Pro",
            quotaInfo: { remainingFraction: 0.6 },
          },
          flash: {
            displayName: "Gemini Flash",
            quotaInfo: { remainingFraction: 0.1 },
          },
          claude: { displayName: "Claude", quotaInfo: {} },
        },
      }),
    ).toMatchObject([{ label: "Gemini · 5 hours", used: 90, remaining: 10 }]);
  });

  it("converts Cursor cents, reports actual allowances and preserves overages", () => {
    const result = mapCursor(
      {
        billingCycleEnd: 1790776800000,
        planUsage: { limit: "2000", totalSpend: 2400, autoPercentUsed: 0 },
        spendLimitUsage: { individualLimit: 5000, individualRemaining: 4500 },
      },
      null,
      null,
      { hasCreditGrants: true, totalCents: 1000, usedCents: 200 },
    );
    expect(result.metrics).toMatchObject([
      { label: "Plan usage", used: 24, limit: 20, remaining: 0, unit: "usd" },
      { label: "Cursor models", used: 0 },
      { label: "On-demand", used: 5, limit: 50 },
      { label: "Credit balance", used: null, limit: null, remaining: 8 },
    ]);
    expect(mapCursor({ planUsage: { limit: 2000 } }).metrics).toEqual([]);
  });

  it("uses the included Enterprise requests and exact billing cycle", () => {
    const result = mapCursor(
      {},
      {
        membershipType: "enterprise",
        billingCycleEnd: "2026-10-01T00:00:00Z",
        individualUsage: {
          plan: { totalPercentUsed: 40 },
          onDemand: { used: 2500, limit: 10000 },
        },
      },
      { "gpt-4": { maxRequestUsage: 500, numRequests: 10 } },
    );
    expect(result.plan).toBe("enterprise");
    expect(result.metrics).toMatchObject([
      {
        label: "Included requests",
        used: 10,
        limit: 500,
        resetAt: Date.parse("2026-10-01T00:00:00Z"),
      },
      { label: "On-demand", used: 25, limit: 100 },
    ]);
  });

  it("accepts Grok proto-JSON zero but refuses malformed periods and monthly-as-weekly quotas", () => {
    const config = {
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: "2026-09-01",
        end: "2026-09-08",
      },
    };
    expect(mapGrok({ config })).toMatchObject([{ label: "Weekly pool", used: 0, remaining: 100 }]);
    expect(
      mapGrok({
        config: {
          ...config,
          currentPeriod: {
            ...config.currentPeriod,
            type: "USAGE_PERIOD_TYPE_MONTHLY",
          },
        },
      }),
    ).toEqual([]);
    expect(() => mapGrok({ config: { ...config, creditUsagePercent: "invalid" } })).toThrow(UsageError);
    expect(() => mapGrok({ config: {} })).toThrow(UsageError);
  });

  it("maps Claude percentages without treating them as fractions", () => {
    expect(
      mapClaude({
        five_hour: { utilization: 0 },
        seven_day: { utilization: 63 },
        extra_usage: {
          is_enabled: true,
          used_credits: 1234,
          monthly_limit: 5000,
        },
      }).metrics,
    ).toMatchObject([
      { used: 0, remaining: 100 },
      { used: 63, remaining: 37 },
      { used: 12.34, limit: 50, unit: "usd" },
    ]);
    expect(mapClaude({ five_hour: {} }).metrics).toEqual([]);
  });

  it("classifies Codex windows by duration when only a weekly primary window exists", () => {
    expect(
      mapCodex(
        {
          plan_type: "pro",
          rate_limit: {
            primary_window: {
              limit_window_seconds: 604800,
              used_percent: 80,
              reset_after_seconds: 10,
            },
          },
          credits: { has_credits: false },
        },
        1000,
      ),
    ).toMatchObject({
      plan: "pro",
      metrics: [
        { label: "Weekly window", used: 80, resetAt: 11000 },
        { label: "Credit balance", remaining: 0 },
      ],
    });
  });
});

describe("usage cache", () => {
  it("deduplicates requests, expires at five minutes and retains dated metrics on failure", async () => {
    let now = 1000;
    const changed = vi.fn();
    const cache = new UsageCache(changed, () => now);
    const data = {
      plan: "Pro",
      metrics: mapGrok({
        config: {
          creditUsagePercent: 50,
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_WEEKLY",
            start: "2026-09-01",
            end: "2026-09-08",
          },
        },
      }),
    };
    const load = vi.fn(async () => data);
    await Promise.all([cache.refresh("account", load), cache.refresh("account", load)]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(cache.get("account")).toMatchObject({
      status: "ready",
      fetchedAt: 1000,
      refreshing: false,
    });
    await cache.refresh("account", load);
    expect(load).toHaveBeenCalledTimes(1);
    now += USAGE_TTL_MS;
    await cache.refresh("account", async () => {
      throw new Error("secret-token");
    });
    expect(cache.get("account")).toMatchObject({
      status: "error",
      fetchedAt: 1000,
      metrics: data.metrics,
    });
    expect(cache.get("account").error).not.toContain("secret-token");
    cache.dispose();
    await cache.refresh("account", load, true);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not resurrect a removed account when an in-flight fetch completes", async () => {
    const changed = vi.fn();
    const cache = new UsageCache(changed);
    let resolve!: (data: { plan: null; metrics: [] }) => void;
    const pending = cache.refresh(
      "account",
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await Promise.resolve();
    cache.remove("account");
    resolve({ plan: null, metrics: [] });
    await pending;
    expect(cache.get("account").status).toBe("loading");
    expect(changed).not.toHaveBeenCalled();
  });
});

describe("usage requests", () => {
  it("loads Antigravity OAuth client configuration at runtime and omits it from returned usage", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      if (String(url).includes("oauth2")) {
        const params = new URLSearchParams(String(init?.body));
        expect(params.get("client_id")).toBe("test-client-id");
        expect(params.get("client_secret")).toBe("test-client-secret");
        return Response.json({ access_token: "new-access", expires_in: 3600 });
      }
      if (String(url).includes("retrieveUserQuotaSummary"))
        return Response.json({ groups: [{ buckets: [{ bucketId: "gemini-5h", remainingFraction: 0.6 }] }] });
      return Response.json({});
    });
    const config = vi.fn(async () => ({ clientId: "test-client-id", clientSecret: "test-client-secret" }));
    const result = await createUsageClient(fetcher, undefined, config)(
      "antigravity",
      JSON.stringify({ token: { refresh_token: "test-refresh" } }),
      vi.fn(),
    );
    expect(result.metrics).toMatchObject([{ used: 40, remaining: 60 }]);
    expect(config).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toMatch(/test-client|test-refresh|new-access/);
  });
  it("does not attempt Google refresh without runtime client configuration", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      createUsageClient(fetcher)(
        "antigravity",
        JSON.stringify({ token: { refresh_token: "test-refresh" } }),
        vi.fn(),
      ),
    ).rejects.toThrow("configure its OAuth client");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("refreshes Grok once, saves rotated credentials, and returns only usage", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("denied", { status: 401 }))
      .mockResolvedValueOnce(Response.json({ subscription_tier_display: "Pro" }))
      .mockResolvedValueOnce(
        Response.json({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          config: {
            creditUsagePercent: 42,
            currentPeriod: {
              type: "USAGE_PERIOD_TYPE_WEEKLY",
              start: "2026-09-01",
              end: "2026-09-08",
            },
          },
        }),
      )
      .mockResolvedValueOnce(Response.json({ subscription_tier_display: "Pro" }));
    const save = vi.fn(async (_body: string) => {});
    const result = await createUsageClient(fetcher)(
      "grok",
      JSON.stringify({
        "issuer::client": {
          key: "old-access",
          refresh_token: "old-refresh",
          email: "test@example.com",
        },
      }),
      save,
    );
    expect(result).toMatchObject({ plan: "Pro", metrics: [{ used: 42 }] });
    expect(JSON.parse(save.mock.calls[0][0])["issuer::client"]).toMatchObject({
      key: "new-access",
      refresh_token: "new-refresh",
      email: "test@example.com",
    });
    expect(JSON.stringify(result)).not.toContain("access");
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it("does not expose response bodies or retry throttling with token refresh", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("private-response", { status: 429 }));
    const save = vi.fn();
    await expect(
      createUsageClient(fetcher)(
        "grok",
        JSON.stringify({
          "issuer::client": { key: "access", refresh_token: "refresh" },
        }),
        save,
      ),
    ).rejects.toThrow("HTTP 429");
    expect(save).not.toHaveBeenCalled();
    expect(fetcher.mock.calls.every(([url]) => !String(url).includes("oauth2"))).toBe(true);
  });
});
