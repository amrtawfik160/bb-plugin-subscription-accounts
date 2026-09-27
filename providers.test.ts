import { describe, expect, it } from "vitest";

import { SWAP_PROVIDERS, swapProviderForThread } from "./providers.js";

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
