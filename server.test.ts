import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeTurnFailedEvent } from "@get-bb/plugin-sdk/testing";
import { DatabaseSync } from "node:sqlite";
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
  vi.unstubAllEnvs();
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
    dataDir: path.join(home, ".bb"),
    sdk: { plugins },
  });
  dispose = () => harness.lifecycle.dispose();
  await plugin(bb);
  await harness.behavior.callRpc("saveCurrent", { provider: "grok" });
  return { file, harness };
}

describe("subscription usage RPC", () => {
  it("lists current quota through the CLI, refreshes on request, and keeps unavailable quota unknown", async () => {
    const fetcher = vi.fn(async () => Response.json(billing));
    vi.stubGlobal("fetch", fetcher);
    const { harness } = await setup();
    const result = await harness.behavior.runCli(["quota", "grok", "--json"]);
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout!);
    expect(report.accounts).toMatchObject([{ provider: "grok", account: "test", email: "test@example.com", active: true, status: "ready", limits: [{ label: "Weekly pool", remaining: 60, unit: "percent" }] }]);
    expect(report).not.toHaveProperty("catalogs");
    expect(result.stdout).not.toMatch(/available models|test-access|test-refresh/);
    fetcher.mockImplementation(async () => new Response("down", { status: 503 }));
    const failed = await harness.behavior.runCli(["quota", "grok", "--refresh", "--json"]);
    expect(JSON.parse(failed.stdout!).accounts[0]).toMatchObject({ status: "error", limits: [{ remaining: null, lastKnownRemaining: 60 }] });
    expect((await harness.behavior.runCli(["quota", "grok"])).stdout).toContain("Weekly pool [account]: unknown left.");
    expect((await harness.behavior.runCli(["quota", "grok", "--refreh"])).exitCode).toBe(1);
  });

  async function fakeGrokLogin(body: string) {
    const bin = path.join(home!, "fake-bin");
    await fs.mkdir(bin, { recursive: true });
    const executable = path.join(bin, "grok");
    await fs.writeFile(executable, `#!/bin/sh
printf '%s\\n' 'https://accounts.x.ai/test' 'ABCD-1234'
sleep 0.2
mkdir -p "$HOME/.grok"
printf '%s' '${body}' > "$HOME/.grok/auth.json"
sleep 5
`, { mode: 0o700 });
    vi.stubEnv("PATH", `${bin}:/usr/bin:/bin`);
  }

  it.each([true, false])("relogs the same saved account while preserving order and active selection (active: %s)", async (active) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(billing)));
    const { file, harness } = await setup();
    await fs.writeFile(file, savedLogin.replaceAll("test@", "other@"));
    await harness.behavior.callRpc("saveCurrent", { provider: "grok" });
    await harness.behavior.callRpc("use", { provider: "grok", name: active ? "test" : "other" });
    const fresh = savedLogin.replace("test-access", "fresh-access").replace("test-refresh", "fresh-refresh");
    await fakeGrokLogin(fresh);
    const started = await harness.behavior.callRpc("loginStart", { provider: "grok", name: "test" });
    expect(started).toMatchObject({ provider: "grok", targetAccount: "test" });
    await vi.waitFor(async () => {
      const overview: any = await harness.behavior.callRpc("overview", null);
      expect(overview.login).toMatchObject({ status: "done", account: "test", targetAccount: "test" });
      const section = overview.swap.find((s: any) => s.id === "grok");
      expect(section.active).toBe(active ? "test" : "other");
      expect(section.accounts.map((a: any) => a.name)).toEqual(["test", "other"]);
      expect(section.accounts[0].usage).toMatchObject({ status: "ready" });
      expect(JSON.stringify(overview)).not.toContain("fresh-refresh");
    }, { timeout: 8_000 });
    expect(await fs.readFile(file, "utf8")).toBe(active ? fresh : savedLogin.replaceAll("test@", "other@"));
    await harness.behavior.callRpc("use", { provider: "grok", name: "test" });
    expect(await fs.readFile(file, "utf8")).toBe(fresh);
  });

  it("rejects a different login without replacing the saved account", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(billing)));
    const { file, harness } = await setup();
    await fakeGrokLogin(savedLogin.replaceAll("test@", "wrong@"));
    await harness.behavior.callRpc("loginStart", { provider: "grok", name: "test" });
    await vi.waitFor(async () => {
      const overview: any = await harness.behavior.callRpc("overview", null);
      expect(overview.login).toMatchObject({ status: "failed", error: "Sign in with test@example.com. Your saved login was kept." });
      expect(overview.swap.find((s: any) => s.id === "grok").accounts.map((a: any) => a.name)).toEqual(["test"]);
    }, { timeout: 8_000 });
    expect(await fs.readFile(file, "utf8")).toBe(savedLogin);
    await harness.behavior.callRpc("use", { provider: "grok", name: "test" });
    expect(await fs.readFile(file, "utf8")).toBe(savedLogin);
  });

  it("keeps saved credentials when a re-login is cancelled and prevents competing sessions", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(billing)));
    const { file, harness } = await setup();
    await fakeGrokLogin(savedLogin.replace("test-access", "fresh-access"));
    await harness.behavior.callRpc("loginStart", { provider: "grok", name: "test" });
    await expect(harness.behavior.callRpc("loginStart", { provider: "grok" })).rejects.toThrow("Finish or cancel");
    await harness.behavior.callRpc("loginCancel", null);
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    const overview: any = await harness.behavior.callRpc("overview", null);
    expect(overview.login).toBeNull();
    expect(await fs.readFile(file, "utf8")).toBe(savedLogin);
    await harness.behavior.callRpc("use", { provider: "grok", name: "test" });
    expect(await fs.readFile(file, "utf8")).toBe(savedLogin);
  });

  it.each([
    ["codex", true], ["claude", true], ["codex", false], ["claude", false],
  ] as const)("switches the %s machine login and preserves its previous login (saved: %s)", async (provider, saved) => {
    const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
    const accounts = [
      { id: "old", provider, kind: "oauth", label: "Old", email: "old@example.com", enabled: true,
        priority: 0, status: "ready", accountUuid: "old", codexAccountId: "old" },
      { id: "new", provider, kind: "oauth", label: "New", email: "new@example.com", enabled: false,
        priority: 1, status: "disabled", accountUuid: "new", codexAccountId: "new", subscriptionType: "pro" },
    ];
    if (!saved) accounts.shift();
    const callRpc = vi.fn(async ({ method }: any) => {
      if (method === "account.list") return accounts;
      if (method === "status.get") return { routing: { claude: true, codex: true } };
      if (method === "account.add") return {
        id: "old", provider, kind: "oauth", label: "Old", email: "old@example.com",
        enabled: true, priority: 2, status: "ready", accountUuid: "old", codexAccountId: "old",
      };
      throw new Error(`Unexpected mutation: ${method}`);
    });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));
    const { harness } = await setup({ list: async () => [{ id: "account-pool", enabled: true }], callRpc });
    const dir = path.join(home!, ".bb/plugins/account-pool/secrets/accounts");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "account-new.json"), JSON.stringify({
      kind: "oauth", accessToken: "new-access", refreshToken: "new-refresh", expiresAt: Date.now() + 3600000,
      idToken: jwt({ email: "new@example.com", "https://api.openai.com/auth": { chatgpt_account_id: "new", chatgpt_plan_type: "pro" } }),
    }));
    const file = path.join(home!, provider === "codex" ? ".codex/auth.json" : ".claude/.credentials.json");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(provider === "codex" ? {
      tokens: { access_token: "old-access", refresh_token: "old-refresh", account_id: "old", id_token: jwt({ email: "old@example.com" }) },
    } : { claudeAiOauth: { accessToken: "old-access", refreshToken: "old-refresh" } }));
    const profile = path.join(home!, ".claude.json");
    if (provider === "claude") await fs.writeFile(profile, JSON.stringify({ theme: "dark", oauthAccount: { emailAddress: "old@example.com", accountUuid: "old" } }));
    expect(await harness.behavior.callRpc("poolUse", { id: "new" })).toBeNull();
    const result = JSON.parse(await fs.readFile(file, "utf8"));
    expect(provider === "codex" ? result.tokens.access_token : result.claudeAiOauth.accessToken).toBe("new-access");
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    if (provider === "claude") expect(JSON.parse(await fs.readFile(profile, "utf8"))).toMatchObject({
      theme: "dark", oauthAccount: { emailAddress: "new@example.com", accountUuid: "new" },
    });
    const overview = await harness.behavior.callRpc("overview", null) as any;
    expect(overview.pool.localLogin[provider]).toMatchObject({ email: "new@example.com", inStack: true, stackAccountId: "new" });
    expect(JSON.stringify(overview)).not.toMatch(/new-access|new-refresh/);
    expect(callRpc.mock.calls.map(([call]) => call.method)).not.toContain("account.enable");
    expect(callRpc.mock.calls.filter(([call]) => call.method === "account.add")).toHaveLength(saved ? 0 : 1);
    await expect(harness.behavior.callRpc("poolUse", { id: "missing" })).rejects.toThrow("unavailable");
    expect(await fs.readFile(file, "utf8")).toBe(JSON.stringify(result));
  });

  it("does not merge Codex organizations that have the same email", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));
    const { harness } = await setup({
      list: async () => [{ id: "account-pool", enabled: true }],
      callRpc: async ({ method }: any) => method === "account.list" ? [{
        id: "saved", provider: "codex", kind: "oauth", label: "Saved", email: "same@example.com",
        codexAccountId: "other-org", enabled: true, priority: 0, status: "ready",
      }] : { routing: { claude: false, codex: false } },
    });
    await fs.mkdir(path.join(home!, ".codex"));
    await fs.writeFile(path.join(home!, ".codex/auth.json"), JSON.stringify({ tokens: {
      refresh_token: "refresh", account_id: "this-org",
      id_token: `h.${Buffer.from(JSON.stringify({ email: "same@example.com" })).toString("base64url")}.s`,
    } }));
    const overview = await harness.behavior.callRpc("overview", null) as any;
    expect(overview.pool.localLogin.codex).toMatchObject({ inStack: false, stackAccountId: null });
  });

  it.each([false, true])("reconnects stale pooled Claude credentials, including in-place imports (%s)", async (reused) => {
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
          id: reused ? "old" : "new",
          label: input.label,
          priority: input.priority,
          status: "ready",
          error: null,
          fiveHourUtilization: 0,
          sevenDayUtilization: 0.95,
        };
        if (reused) accounts.splice(0, 1, fresh);
        else accounts.push(fresh);
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
      { id: reused ? "old" : "new", priority: 5, label: "Saved", status: "ready" },
    ]);
    if (reused) {
      expect(calls).not.toContain("account.remove");
      expect(calls).not.toContain("account.reorder");
      return;
    }
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

describe("Claude and Codex direct switching", () => {
  async function host(threads?: {
    get: (input: { threadId: string }) => Promise<{ providerId: string }>;
    stop: () => Promise<void>;
    retry: (input: { reason?: string }) => Promise<void>;
    events: { list: () => Promise<{ data: { detail: string } }[]> };
  }) {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "direct-switch-"));
    vi.spyOn(os, "homedir").mockReturnValue(home);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));
    const created = createFakePluginHost({
      pluginId: "subscription-accounts",
      dataDir: path.join(home, ".bb"),
      sdk: { plugins: { list: async () => [] }, ...(threads ? { threads } : {}) },
    });
    dispose = () => created.harness.lifecycle.dispose();
    await plugin(created.bb);
    return created.harness;
  }

  async function writeClaude(access: string, uuid: string, email: string) {
    const creds = path.join(home!, ".claude/.credentials.json");
    await fs.mkdir(path.dirname(creds), { recursive: true });
    await fs.writeFile(creds, JSON.stringify({
      claudeAiOauth: { accessToken: access, refreshToken: `refresh-${access}`, subscriptionType: "max" },
    }));
    await fs.writeFile(path.join(home!, ".claude.json"), JSON.stringify({
      theme: "dark",
      oauthAccount: { emailAddress: email, accountUuid: uuid },
    }));
  }

  function threadsFor(providerId: string, detail: string) {
    return {
      get: vi.fn(async () => ({ providerId })),
      stop: vi.fn(async () => undefined),
      retry: vi.fn(async () => undefined),
      events: { list: vi.fn(async () => [{ data: { detail } }]) },
    };
  }

  it("switches the Claude login after a 5-hour limit and retries the turn", async () => {
    const threads = threadsFor(
      "claude-code",
      "You've hit your session limit. 5-hour limit reached. Resets in 3h12m.",
    );
    const harness = await host(threads);
    await writeClaude("access-a", "uuid-a", "a@example.com");
    await harness.behavior.callRpc("saveCurrent", { provider: "claude" });
    await writeClaude("access-b", "uuid-b", "b@example.com");
    await harness.behavior.callRpc("saveCurrent", { provider: "claude" });
    await writeClaude("access-a", "uuid-a", "a@example.com");
    await harness.behavior.emitThreadEvent("turn.failed", makeTurnFailedEvent({ threadId: "thr_limit" }));
    const creds = JSON.parse(await fs.readFile(path.join(home!, ".claude/.credentials.json"), "utf8"));
    const profile = JSON.parse(await fs.readFile(path.join(home!, ".claude.json"), "utf8"));
    expect(creds.claudeAiOauth.accessToken).toBe("access-b");
    expect(profile).toMatchObject({ theme: "dark", oauthAccount: { accountUuid: "uuid-b", emailAddress: "b@example.com" } });
    expect(threads.retry).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "thr_limit",
      reason: expect.stringContaining("Continuing on b"),
    }));
    expect(threads.stop).toHaveBeenCalled();
  });

  it("does not switch Claude on a disabled pooler error or an auth failure", async () => {
    for (const detail of [
      'API Error: 503 {"ok":false,"error":"plugin \\"account-pool\\" is not running (status: disabled)"}.',
      "HTTP 401 unauthorized",
    ]) {
      const threads = threadsFor("claude-code", detail);
      const harness = await host(threads);
      await writeClaude("access-a", "uuid-a", "a@example.com");
      await harness.behavior.callRpc("saveCurrent", { provider: "claude" });
      await harness.behavior.emitThreadEvent("turn.failed", makeTurnFailedEvent({ threadId: "thr_keep" }));
      const creds = JSON.parse(await fs.readFile(path.join(home!, ".claude/.credentials.json"), "utf8"));
      expect(creds.claudeAiOauth.accessToken).toBe("access-a");
      expect(threads.retry).not.toHaveBeenCalled();
      await dispose?.();
      await fs.rm(home!, { recursive: true, force: true });
      home = undefined;
    }
  });

  it("names the earliest reset when every Claude login is out of quota", async () => {
    const threads = threadsFor(
      "claude-code",
      "You've hit your weekly limit. Resets at 2027-01-01T00:00:00.000Z.",
    );
    const harness = await host(threads);
    await writeClaude("access-a", "uuid-a", "only@example.com");
    await harness.behavior.callRpc("saveCurrent", { provider: "claude" });
    await harness.behavior.emitThreadEvent("turn.failed", makeTurnFailedEvent({ threadId: "thr_wait" }));
    expect(threads.retry).toHaveBeenCalledWith(expect.objectContaining({
      reason: expect.stringContaining("2027-01-01T00:00:00.000Z"),
    }));
    const creds = JSON.parse(await fs.readFile(path.join(home!, ".claude/.credentials.json"), "utf8"));
    expect(creds.claudeAiOauth.accessToken).toBe("access-a");
  });

  it("switches Codex on a usage limit and ignores the pooler route error", async () => {
    const threads = threadsFor("codex", "You've hit your usage limit. Try again in 44m.");
    const harness = await host(threads);
    const auth = path.join(home!, ".codex/auth.json");
    await fs.mkdir(path.dirname(auth), { recursive: true });
    const body = (access: string, accountId: string, email: string) => JSON.stringify({
      tokens: {
        access_token: access,
        refresh_token: `refresh-${access}`,
        account_id: accountId,
        id_token: `h.${Buffer.from(JSON.stringify({
          email,
          "https://api.openai.com/auth": { chatgpt_account_id: accountId },
        })).toString("base64url")}.s`,
      },
    });
    await fs.writeFile(auth, body("codex-a", "org-a", "a@example.com"));
    await harness.behavior.callRpc("saveCurrent", { provider: "codex" });
    await fs.writeFile(auth, body("codex-b", "org-b", "b@example.com"));
    await harness.behavior.callRpc("saveCurrent", { provider: "codex" });
    await fs.writeFile(auth, body("codex-a", "org-a", "a@example.com"));
    await harness.behavior.emitThreadEvent("turn.failed", makeTurnFailedEvent({ threadId: "thr_codex" }));
    const saved = JSON.parse(await fs.readFile(auth, "utf8"));
    expect(saved.tokens.access_token).toBe("codex-b");
    expect(threads.retry).toHaveBeenCalled();

    threads.events.list.mockResolvedValue([{ data: { detail:
      "unexpected status 503 Service Unavailable, url: http://127.0.0.1:9/api/v1/plugins/account-pool/http/v1/responses" } }]);
    threads.retry.mockClear();
    await fs.writeFile(auth, body("codex-a", "org-a", "a@example.com"));
    await harness.behavior.emitThreadEvent("turn.failed", makeTurnFailedEvent({ threadId: "thr_codex", attemptNumber: 2 }));
    expect(JSON.parse(await fs.readFile(auth, "utf8")).tokens.access_token).toBe("codex-a");
    expect(threads.retry).not.toHaveBeenCalled();
  });

  it("clears the pooler route and copies only enabled saved logins", async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "direct-import-"));
    vi.spyOn(os, "homedir").mockReturnValue(home);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));
    const dataDir = path.join(home, ".bb");
    const secretDir = path.join(dataDir, "plugins/account-pool/secrets/accounts");
    await fs.mkdir(secretDir, { recursive: true });
    await fs.writeFile(path.join(secretDir, "account-on.json"), JSON.stringify({
      kind: "oauth", accessToken: "imported-access", refreshToken: "imported-refresh", expiresAt: Date.now() + 3_600_000,
    }));
    const db = new DatabaseSync(path.join(dataDir, "bb.db"));
    db.exec("CREATE TABLE plugin_kv (plugin_id TEXT, key TEXT, value TEXT, updated_at INTEGER)");
    db.prepare("INSERT INTO plugin_kv (plugin_id, key, value, updated_at) VALUES (?, ?, ?, ?)").run(
      "account-pool",
      "accounts:v1",
      JSON.stringify([
        { id: "on", provider: "claude", kind: "oauth", label: "On", email: "on@example.com", enabled: true, priority: 1, subscriptionType: "max", rateLimitTier: null, accountUuid: "uuid-on", codexAccountId: null },
        { id: "off", provider: "claude", kind: "oauth", label: "Off", email: "off@example.com", enabled: false, priority: 2, subscriptionType: null, rateLimitTier: null, accountUuid: "uuid-off", codexAccountId: null },
      ]),
      Date.now(),
    );
    db.close();
    await fs.mkdir(path.dirname(path.join(dataDir, "plugins/account-pool/data.db")), { recursive: true });
    const active = new DatabaseSync(path.join(dataDir, "plugins/account-pool/data.db"));
    active.exec("CREATE TABLE pool_active_account (provider TEXT, account_id TEXT)");
    active.prepare("INSERT INTO pool_active_account (provider, account_id) VALUES (?, ?)").run("claude", "on");
    active.close();
    await writeClaude("live-access", "uuid-live", "live@example.com");
    const created = createFakePluginHost({
      pluginId: "subscription-accounts",
      dataDir,
      sdk: { plugins: { list: async () => [] } },
    });
    dispose = () => created.harness.lifecycle.dispose();
    await plugin(created.bb);
    const creds = JSON.parse(await fs.readFile(path.join(home, ".claude/.credentials.json"), "utf8"));
    expect(creds.claudeAiOauth.accessToken).toBe("live-access");
    const overview = await created.harness.behavior.callRpc("overview", null) as {
      swap: { id: string; active: string | null; accounts: { name: string; email: string | null }[] }[];
    };
    const claude = overview.swap.find((section) => section.id === "claude");
    expect(claude?.accounts.map((account) => account.email).sort()).toEqual(["live@example.com", "on@example.com"]);
    expect(claude?.active).toBe("live");
    expect(JSON.stringify(overview)).not.toContain("imported-access");
    const env = await created.harness.behavior.resolveProviderEnv("claude-code", {
      threadId: "t", projectId: "p", hostId: "h",
    });
    expect(env.map((entry) => entry.name)).toEqual(["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]);
    expect(env.every((entry) => entry.value === "")).toBe(true);
    expect(JSON.stringify(env)).not.toMatch(/account-pool/i);
    const codexEnv = await created.harness.behavior.resolveProviderEnv("codex", {
      threadId: "t", projectId: "p", hostId: "h",
    });
    expect(codexEnv.map((entry) => entry.name)).toEqual(["CODEX_OPENAI_BASE_URL", "CODEX_POOL_AUTH_TOKEN"]);
    await expect(created.harness.behavior.callRpc("poolEnable", null)).rejects.toThrow(/Account Pooler/);
    await expect(created.harness.behavior.callRpc("loginStart", { provider: "claude" })).rejects.toThrow(/CLI/);
    const reloaded = await created.harness.lifecycle.reload(plugin);
    dispose = () => reloaded.harness.lifecycle.dispose();
    const again = await reloaded.harness.behavior.callRpc("overview", null) as typeof overview;
    expect(again.swap.find((section) => section.id === "claude")?.accounts).toHaveLength(2);
  });
});
