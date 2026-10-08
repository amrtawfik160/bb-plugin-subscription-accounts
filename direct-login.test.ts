import { describe, expect, it } from "vitest";

import {
  classifySubscriptionLimit,
  directLoginEnv,
  stackLoginFromPooler,
} from "./direct-login.js";

const NOW = Date.parse("2026-10-08T16:00:00.000Z");

describe("subscription limit failures", () => {
  it("reads a 5-hour limit and its reset time", () => {
    const detail =
      "You've hit your session limit. 5-hour limit reached. Resets in 3h12m.";
    expect(classifySubscriptionLimit(detail, NOW)).toEqual({
      kind: "five-hour",
      resetAt: NOW + (3 * 60 + 12) * 60_000,
    });
  });

  it("reads a weekly limit and an absolute reset time", () => {
    const detail =
      "You've hit your weekly limit. usage_limit_reached. Resets at 2026-10-08T19:45:00.000Z.";
    expect(classifySubscriptionLimit(detail, NOW)).toEqual({
      kind: "weekly",
      resetAt: Date.parse("2026-10-08T19:45:00.000Z"),
    });
  });

  it("treats a Codex usage limit with a relative reset as the 5-hour window", () => {
    expect(
      classifySubscriptionLimit("You've hit your usage limit. Try again in 44m.", NOW),
    ).toEqual({ kind: "five-hour", resetAt: NOW + 44 * 60_000 });
  });

  it("does not switch when the reset time is already past", () => {
    expect(
      classifySubscriptionLimit("You've hit your session limit. Resets at 2026-10-08T15:00:00.000Z.", NOW),
    ).toEqual({ kind: "none" });
  });

  it("does not switch on the disabled pooler, a short overload, or an auth failure", () => {
    const ignored = [
      'API Error: 503 {"ok":false,"error":"plugin \\"account-pool\\" is not running (status: disabled)"}.',
      "API Error: Request rejected (429) · No Account Pooler account is currently eligible.",
      "Selected model is at capacity. Please try a different model.",
      "HTTP 401 unauthorized",
      "unexpected status 503 Service Unavailable, url: http://127.0.0.1:38886/api/v1/plugins/account-pool/http/v1/responses",
    ];
    for (const detail of ignored) {
      expect(classifySubscriptionLimit(detail, NOW)).toEqual({ kind: "none" });
    }
  });
});

describe("direct login routing", () => {
  it("clears the pooler URL for Claude Code and Codex", () => {
    for (const providerId of ["claude-code", "codex"] as const) {
      const entries = directLoginEnv(providerId);
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.value).toBe("");
        expect(JSON.stringify(entry)).not.toMatch(/account-pool/i);
      }
    }
    expect(directLoginEnv("claude-code").map((entry) => entry.name)).toEqual([
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_AUTH_TOKEN",
    ]);
    expect(directLoginEnv("codex").map((entry) => entry.name)).toEqual([
      "CODEX_OPENAI_BASE_URL",
      "CODEX_POOL_AUTH_TOKEN",
    ]);
  });
});

describe("stack logins copied from saved pooler accounts", () => {
  it("builds a Claude login without dropping a disabled account's source", () => {
    const secret = JSON.stringify({
      kind: "oauth",
      accessToken: "claude-access",
      refreshToken: "claude-refresh",
      expiresAt: NOW + 3_600_000,
    });
    const saved = stackLoginFromPooler(
      {
        id: "acct-claude",
        provider: "claude",
        kind: "oauth",
        email: "amr@example.com",
        label: "amr",
        enabled: true,
        priority: 1,
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_20x",
        accountUuid: "uuid-1",
        codexAccountId: null,
      },
      secret,
    );
    expect(saved).toMatchObject({
      provider: "claude",
      name: "amr",
      key: "uuid-1",
      email: "amr@example.com",
    });
    const stored = JSON.parse(saved!.body) as {
      kind: string;
      credentials: string;
      accountUuid: string;
    };
    expect(stored.kind).toBe("claude-stack");
    expect(stored.accountUuid).toBe("uuid-1");
    expect(JSON.parse(stored.credentials).claudeAiOauth).toMatchObject({
      accessToken: "claude-access",
      refreshToken: "claude-refresh",
      subscriptionType: "max",
    });
    const codex = stackLoginFromPooler(
      {
        id: "acct-codex",
        provider: "codex",
        kind: "oauth",
        email: "ada@example.com",
        label: "ada",
        enabled: true,
        priority: 1,
        subscriptionType: "pro",
        rateLimitTier: null,
        accountUuid: null,
        codexAccountId: "org-1",
      },
      secret,
    );
    expect(codex).toMatchObject({ provider: "codex", name: "ada", key: "org-1", email: "ada@example.com" });
    expect(JSON.parse(codex!.body).tokens).toMatchObject({
      access_token: "claude-access",
      account_id: "org-1",
    });
    expect(stackLoginFromPooler(
      {
        id: "off",
        provider: "codex",
        kind: "oauth",
        email: "off@example.com",
        label: "off",
        enabled: false,
        priority: 2,
        subscriptionType: null,
        rateLimitTier: null,
        accountUuid: null,
        codexAccountId: "org-1",
      },
      secret,
    )).toBeNull();
  });
});
