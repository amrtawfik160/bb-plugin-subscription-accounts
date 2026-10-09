import { describe, expect, it } from "vitest";

import { SWAP_PROVIDERS, readClaudeLocal, readCodexLocal, swapProviderForThread } from "./providers.js";

const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

describe("identify", () => {
  it("reads agy's login file", () => {
    const body = JSON.stringify({
      token: { access_token: "a", refresh_token: "r" },
      auth_method: "consumer",
      id_token: jwt({ email: "me@gmail.com" }),
    });
    expect(SWAP_PROVIDERS.antigravity.identify(body)).toEqual({ key: "me@gmail.com", email: "me@gmail.com" });
    expect(() => SWAP_PROVIDERS.antigravity.identify(JSON.stringify({ token: {} }))).toThrow(/refresh token/);
  });

  it("keys Cursor logins by the token subject", () => {
    const body = JSON.stringify({ accessToken: jwt({ sub: "auth0|123" }), refreshToken: "r" });
    expect(SWAP_PROVIDERS.cursor.identify(body)).toEqual({ key: "auth0|123", email: null });
  });

  it("reads Grok's issuer-keyed login file", () => {
    const body = JSON.stringify({
      "https://auth.x.ai::client": { email: "me@x.ai", user_id: "u1", refresh_token: "r" },
    });
    expect(SWAP_PROVIDERS.grok.identify(body)).toEqual({ key: "me@x.ai", email: "me@x.ai" });
  });

  it("rejects garbage", () => {
    expect(() => SWAP_PROVIDERS.grok.identify("nope")).toThrow(/JSON/);
  });
});

describe("quota patterns", () => {
  const agy =
    "Internal error: agy failed: Error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h51m28s.";

  it("match the agy errors seen in bb", () => {
    expect(SWAP_PROVIDERS.antigravity.quota.test(agy)).toBe(true);
    expect(SWAP_PROVIDERS.antigravity.quota.test('AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429)')).toBe(true);
  });

  it("match common usage-limit wording", () => {
    expect(SWAP_PROVIDERS.cursor.quota.test("You've hit your usage limit")).toBe(true);
    expect(SWAP_PROVIDERS.grok.quota.test("Rate limit exceeded for this plan")).toBe(true);
  });

  it("ignore unrelated failures", () => {
    expect(SWAP_PROVIDERS.cursor.quota.test("No active ACP session")).toBe(false);
    expect(SWAP_PROVIDERS.grok.quota.test("HTTP/2 stream closed")).toBe(false);
  });
});

describe("swapProviderForThread", () => {
  it("maps bb provider ids", () => {
    expect(swapProviderForThread("acp-antigravity")?.id).toBe("antigravity");
    expect(swapProviderForThread("acp-cursor")?.id).toBe("cursor");
    expect(swapProviderForThread("claude-code")).toBeNull();
    expect(swapProviderForThread(null)).toBeNull();
  });
});

describe("local Claude / Codex logins", () => {
  it("reads the Claude plan and email", () => {
    const creds = JSON.stringify({
      claudeAiOauth: { refreshToken: "r", subscriptionType: "max", rateLimitTier: "default_claude_max_20x" },
    });
    const profile = JSON.stringify({ oauthAccount: { emailAddress: "me@x.com" } });
    expect(readClaudeLocal(creds, profile)).toEqual({ email: "me@x.com", plan: "Max 20x", accountId: null });
    expect(readClaudeLocal(creds, null)).toEqual({ email: null, plan: "Max 20x", accountId: null });
    expect(readClaudeLocal(JSON.stringify({}), profile)).toBeNull();
    expect(readClaudeLocal(null, profile)).toBeNull();
  });

  it("reads the Codex plan and email from the id token", () => {
    const auth = JSON.stringify({
      tokens: {
        refresh_token: "r",
        id_token: jwt({ email: "me@x.com", "https://api.openai.com/auth": { chatgpt_plan_type: "pro" } }),
      },
    });
    expect(readCodexLocal(auth)).toEqual({ email: "me@x.com", plan: "Pro", accountId: null });
    expect(readCodexLocal(JSON.stringify({ OPENAI_API_KEY: "k" }))).toBeNull();
  });
});

describe("Claude sign-in link", () => {
  it("matches the links current and older Claude Code builds print", async () => {
    const { CLI_LOGIN_SPECS } = await import("./providers");
    const pattern = CLI_LOGIN_SPECS.claude.urlPattern;
    for (const url of [
      "https://claude.com/cai/oauth/authorize?code=true&client_id=x",
      "https://claude.ai/oauth/authorize?code=true",
      "https://platform.claude.com/oauth/authorize?code=true",
    ]) {
      expect(pattern.exec(`visit: ${url}\n`)?.[0]).toBe(url);
    }
  });
});
