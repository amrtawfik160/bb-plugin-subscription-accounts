import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

const billing = {
  config: {
    creditUsagePercent: 40,
    currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-09-01", end: "2026-09-08" },
  },
};
const savedLogin = JSON.stringify({
  "issuer::client": { key: "test-access", refresh_token: "test-refresh", email: "test@example.com" },
});
let dispose: (() => Promise<void>) | undefined;
let home: string | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (home) await fs.rm(home, { recursive: true, force: true });
});

async function setup(plugins = { list: async () => [] } as any) {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "subscription-usage-test-"));
  vi.spyOn(os, "homedir").mockReturnValue(home);
  const file = path.join(home, ".grok/auth.json");
  await fs.mkdir(path.dirname(file));
  await fs.writeFile(file, savedLogin, { mode: 0o600 });
  const { bb, harness } = createFakePluginHost({
    pluginId: "subscription-accounts",
    sdk: { plugins },
  });
  dispose = () => harness.lifecycle.dispose();
  await plugin(bb);
  await harness.behavior.callRpc("saveCurrent", { provider: "grok" });
  return { file, harness };
}

describe("subscription usage RPC", () => {
  it("reconnects stale pooled Claude credentials only after verifying the live account, preserving order", async () => {
    const old = {
      id: "old",
      provider: "claude",
      kind: "oauth",
      label: "Saved",
      email: "test@example.com",
      accountUuid: "account-uuid",
      enabled: true,
      priority: 5,
      status: "error",
      error: "OAuth refresh failed with HTTP 400.",
    };
    const accounts: any[] = [old];
    const calls: string[] = [];
    const callRpc = vi.fn(async ({ method, input, outputSchema }: any) => {
      calls.push(method);
      let result: any = null;
      if (method === "account.list") result = accounts;
      if (method === "status.get")
        result = { routing: { claude: true, codex: false } };
      if (method === "account.add") {
        const fresh = {
          ...old,
          id: "new",
          label: input.label,
          priority: input.priority,
          status: "ready",
          error: null,
          fiveHourUtilization: 0,
          sevenDayUtilization: 0.95,
        };
        accounts.push(fresh);
        const { status, ...metadata } = fresh;
        result = metadata;
      }
      if (method === "account.remove") {
        accounts.splice(
          accounts.findIndex((a) => a.id === input.id),
          1,
        );
        result = { removed: true };
      }
      return outputSchema.parse(result);
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        Response.json(
          url.includes("/profile")
            ? { account: { uuid: "account-uuid" } }
            : url.includes("/usage")
              ? {
                  five_hour: { utilization: 0 },
                  seven_day: { utilization: 95 },
                }
              : {},
        ),
      ),
    );
    const { harness } = await setup({
      list: async () => [{ id: "account-pool", enabled: true }],
      callRpc,
    });
    await fs.mkdir(path.join(home!, ".claude"));
    await fs.writeFile(
      path.join(home!, ".claude/.credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "live-access",
          refreshToken: "live-refresh",
        },
      }),
    );
    await harness.behavior.callRpc("poolRefresh", { id: "old" });
    expect(accounts).toMatchObject([
      { id: "new", priority: 5, label: "Saved", status: "ready" },
    ]);
    expect(calls.indexOf("account.reorder")).toBeLessThan(
      calls.indexOf("account.remove"),
    );
    expect(
      callRpc.mock.calls.find(([c]) => c.method === "account.reorder")?.[0]
        .input.accountIds,
    ).toEqual(["new", "old"]);
  });

  it("does not replace a pool account with another CLI account", async () => {
    const add = vi.fn();
    const account = {
      id: "old",
      provider: "claude",
      kind: "oauth",
      label: "Saved",
      email: "test@example.com",
      accountUuid: "expected",
      enabled: true,
      priority: 5,
      status: "error",
      error: "OAuth refresh failed with HTTP 400.",
    };
    const callRpc = async ({ method }: any) =>
      method === "account.list"
        ? [account]
        : method === "status.get"
          ? { routing: { claude: true, codex: false } }
          : method === "account.add"
            ? add()
            : null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        Response.json(
          url.includes("/profile")
            ? { account: { uuid: "other" } }
            : { five_hour: { utilization: 0 } },
        ),
      ),
    );
    const { harness } = await setup({
      list: async () => [{ id: "account-pool", enabled: true }],
      callRpc,
    });
    await fs.mkdir(path.join(home!, ".claude"));
    await fs.writeFile(
      path.join(home!, ".claude/.credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "live-access",
          refreshToken: "live-refresh",
        },
      }),
    );
    await expect(
      harness.behavior.callRpc("poolRefresh", { id: "old" }),
    ).rejects.toThrow("another account");
    expect(add).not.toHaveBeenCalled();
  });
  it("exposes local history through validated RPC without conversation or credential data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({})),
    );
    const { harness } = await setup();
    const dir = path.join(home!, ".grok/sessions/test");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "updates.jsonl"),
      JSON.stringify({
        privateText: "private-conversation",
        params: {
          _meta: { eventId: "usage-event", agentTimestampMs: Date.now() },
          update: {
            sessionUpdate: "turn_completed",
            usage: {
              modelUsage: { grok: { inputTokens: 100, outputTokens: 10, costUsdTicks: 6_700_000_000 } },
            },
          },
        },
      }) + "\n",
    );
    await harness.behavior.callRpc("historyRefresh", { provider: "grok" });
    const result = (await harness.behavior.callRpc("overview", null)) as any;
    expect(result.history.grok).toMatchObject({
      status: "ready",
      source: "local",
      models: [{ model: "grok", tokens: 110, costUsd: 0.67 }],
    });
    expect(JSON.stringify(result.history)).not.toMatch(/private-conversation|test-access|test-refresh/);
  });
  it("returns normalized usage and never includes saved credentials", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        Response.json(url.includes("billing") ? billing : { subscription_tier_display: "Pro" }),
      ),
    );
    const { harness } = await setup();
    await harness.behavior.callRpc("usageRefresh", { provider: "grok", name: "test" });
    const result = (await harness.behavior.callRpc("overview", null)) as any;
    expect(result.swap.find((s: any) => s.id === "grok").accounts[0].usage).toMatchObject({
      status: "ready",
      plan: "Pro",
      metrics: [{ used: 40, remaining: 60 }],
    });
    expect(JSON.stringify(result)).not.toContain("test-access");
    expect(JSON.stringify(result)).not.toContain("test-refresh");
    await expect(
      harness.behavior.callRpc("usageRefresh", { provider: "grok", name: "missing" }),
    ).rejects.toThrow();
  });

  it("does not replace a newer CLI login while persisting a refreshed token", async () => {
    const newer = savedLogin.replace("test-access", "newer-cli-access");
    let tokenFile: string;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("oauth2")) {
          await fs.writeFile(tokenFile, newer, { mode: 0o600 });
          return Response.json({
            access_token: "usage-refreshed-access",
            refresh_token: "usage-refresh",
            expires_in: 3600,
          });
        }
        if (url.includes("settings")) return Response.json({});
        const live = await fs.readFile(tokenFile, "utf8");
        return live === savedLogin ? new Response("denied", { status: 401 }) : Response.json(billing);
      }),
    );
    const { file, harness } = await setup();
    tokenFile = file;
    await harness.behavior.callRpc("usageRefresh", { provider: "grok", name: "test" });
    expect(await fs.readFile(file, "utf8")).toBe(newer);
  });
});
