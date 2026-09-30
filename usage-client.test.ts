import { describe, expect, it, vi } from "vitest";
import { createLocalUsageClient } from "./usage-client";
import { mapCodex } from "./usage";

const claude = JSON.stringify({
  claudeAiOauth: {
    accessToken: "old-access",
    refreshToken: "refresh",
    expiresAt: Date.now() + 3600000,
  },
});
const codex = JSON.stringify({
  tokens: {
    access_token: "old-access",
    refresh_token: "refresh",
    account_id: "account",
  },
});

describe("OpenUsage local quota fetching", () => {
  it.each(["claude", "codex"] as const)(
    "refreshes %s once after unauthorized and persists rotated credentials",
    async (provider) => {
      const save = vi.fn(async (_updated: string, _expected: string) => true);
      const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/token"))
          return Response.json({
            access_token: "new-access",
            refresh_token: "new-refresh",
            expires_in: 3600,
          });
        if (
          new Headers(init?.headers).get("Authorization") ===
          "Bearer old-access"
        )
          return new Response(null, { status: 401 });
        return Response.json(
          provider === "claude"
            ? { five_hour: { utilization: 0 } }
            : {
                rate_limit: {
                  primary_window: {
                    used_percent: 25,
                    limit_window_seconds: 604800,
                  },
                },
              },
        );
      });
      const result = await createLocalUsageClient(fetcher as typeof fetch)(
        provider,
        provider === "claude" ? claude : codex,
        { save },
      );
      expect(result.metrics[0]).toMatchObject({
        used: provider === "claude" ? 0 : 25,
      });
      expect(fetcher).toHaveBeenCalledTimes(3);
      const persisted = JSON.parse(save.mock.calls[0][0]);
      expect(
        provider === "claude"
          ? persisted.claudeAiOauth.refreshToken
          : persisted.tokens.refresh_token,
      ).toBe("new-refresh");
    },
  );

  it("uses a newer CLI login before rotating a token owned by another process", async () => {
    const reload = vi.fn(async () =>
      claude.replace("old-access", "cli-access"),
    );
    const save = vi.fn();
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) =>
      new Headers(init?.headers).get("Authorization") === "Bearer cli-access"
        ? Response.json({ five_hour: { utilization: 12 } })
        : new Response(null, { status: 403 }),
    );
    const result = await createLocalUsageClient(fetcher as typeof fetch)(
      "claude",
      claude,
      { reload, save },
    );
    expect(result.metrics[0].used).toBe(12);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(save).not.toHaveBeenCalled();
  });

  it("reads Codex quota and credit header fallbacks", async () => {
    const fetcher = vi.fn(async () =>
      Response.json(
        {},
        {
          headers: {
            "x-codex-primary-used-percent": "0",
            "x-codex-secondary-used-percent": "94",
            "x-codex-credits-balance": "62500",
          },
        },
      ),
    );
    const result = await createLocalUsageClient(fetcher as typeof fetch)(
      "codex",
      codex,
    );
    expect(result.metrics).toMatchObject([
      { label: "5-hour window", used: 0 },
      { label: "Weekly window", used: 94 },
      { label: "Credit balance", remaining: 62500 },
    ]);
  });

  it("prefers the explicit Codex period over an earlier slot fallback", () => {
    const result = mapCodex({
      rate_limit: {
        primary_window: { used_percent: 3 },
        secondary_window: { used_percent: 19, limit_window_seconds: 18000 },
      },
    });
    expect(result.metrics).toMatchObject([
      { label: "5-hour window", used: 19, windowMs: 18000000 },
    ]);
  });
});
