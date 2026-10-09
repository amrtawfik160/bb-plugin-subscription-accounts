// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { emptyUsage, type AccountUsage } from "./usage";
import { aggregateHistory, emptyHistory } from "./history";

afterEach(cleanup);

const now = Date.now();
function fixture(usage: AccountUsage) {
  return {
    now,
    autoSwitch: true,
    swap: [
      {
        id: "antigravity",
        label: "Antigravity",
        installed: true,
        active: "test-account",
        accounts: [
          {
            name: "test-account",
            email: "test@example.com",
            active: true,
            exhaustedUntil: 0,
            lastError: null,
            usage,
          },
        ],
        live: { email: "test@example.com", signedIn: true, saved: true },
      },
    ],
    pool: {
      installed: true,
      enabled: false,
      routing: { claude: false, codex: false },
      accounts: [],
      error: null,
      localLogin: {
        claude: null,
        codex: {
          email: "test@example.com",
          plan: "Pro",
          inStack: false,
          usage,
        },
      },
    },
    login: null,
  };
}

const ready: AccountUsage = {
  ...emptyUsage(),
  status: "ready",
  plan: "Pro",
  fetchedAt: now,
  metrics: [
    {
      label: "Gemini · weekly",
      used: 75,
      remaining: 25,
      limit: 100,
      unit: "percent",
      resetAt: now + 3_600_000,
    },
  ],
};

describe("subscription usage page", () => {
  it("offers account-specific re-login instead of duplicate expired-login errors", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const loginStart = vi.fn(async () => ({
      id: "relogin", provider: "antigravity", targetAccount: "test-account",
      status: "waiting", url: "https://accounts.google.com/test", userCode: null,
      needsCode: true, expiresAt: now + 58_000, error: null, account: null,
    }));
    const slot = renderSlot(app.navPanels[0], { subPath: "" }, {
      rpc: {
        overview: () => fixture({ ...emptyUsage(), status: "error", error: "Antigravity login expired. Refresh the CLI login or configure its OAuth client in plugin settings." }),
        loginStart,
      },
    });
    const action = await slot.findByRole("button", { name: "Log in again for test-account" });
    expect(slot.getByText("Login expired. Log in again to load usage.")).toBeTruthy();
    expect(slot.queryByText(/Usage could not be loaded/)).toBeNull();
    expect(slot.queryByText(/configure its OAuth client/)).toBeNull();
    fireEvent.click(action);
    await waitFor(() => expect(loginStart).toHaveBeenCalledWith({ provider: "antigravity", name: "test-account" }));
    expect(await slot.findByText("Log in again for test-account")).toBeTruthy();
    expect(slot.getByText(/Open the sign-in page/).textContent).toContain("test@example.com");
    slot.lifecycle.unmount();
  });

  it("shows sign-in start failures inline and reports cancellation after retry", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const loginStart = vi.fn().mockRejectedValueOnce(new Error("The CLI is not installed.")).mockResolvedValueOnce({
      id: "retry", provider: "antigravity", targetAccount: "test-account", status: "waiting",
      url: "https://accounts.google.com/test", userCode: null, needsCode: true,
      expiresAt: now + 58_000, error: null, account: null,
    });
    const loginCancel = vi.fn(async () => null);
    const slot = renderSlot(app.navPanels[0], { subPath: "" }, {
      rpc: { overview: () => fixture(ready), loginStart, loginCancel },
    });
    fireEvent.click(await slot.findByRole("button", { name: "Log in again for test-account" }));
    expect((await slot.findByRole("alert")).textContent).toBe("The CLI is not installed.");
    fireEvent.click(slot.getByRole("button", { name: "Try again" }));
    await slot.findByRole("link", { name: "Open sign-in page" });
    fireEvent.click(slot.getByRole("button", { name: "Cancel" }));
    expect(await slot.findByText("Sign-in cancelled. Your saved accounts were kept.")).toBeTruthy();
    expect(loginCancel).toHaveBeenCalledTimes(1);
    expect(slot.getByRole("button", { name: "Log in again for test-account" })).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it.each(["codex", "claude"] as const)("switches the %s machine account independently of account routing", async (provider) => {
    const app = await loadPluginApp(() => import("./app"));
    const view = fixture(ready);
    const account = (id: string, enabled: boolean) => ({
      id, provider, label: id, email: `${id}@example.com`, subscriptionType: "Pro",
      enabled, status: enabled ? "ready" : "disabled", fiveHourUtilization: null,
      fiveHourResetAt: null, sevenDayUtilization: null, sevenDayResetAt: null,
      heldUntil: null, error: null, canUseMachine: true,
    });
    const data: any = {
      ...view, pool: {
        ...view.pool, enabled: true, accounts: [account("current", true), account("other", false)],
        localLogin: { ...view.pool.localLogin,
          [provider]: { email: "current@example.com", plan: "Pro", inStack: true, stackAccountId: "current", usage: ready },
        },
      },
    };
    let finish: (() => void) | undefined;
    const poolUse = vi.fn((input: unknown) => new Promise<null>((resolve) => {
      const { id } = input as { id: string };
      finish = () => {
        data.pool.localLogin[provider] = { ...data.pool.localLogin[provider], stackAccountId: id, email: `${id}@example.com` };
        resolve(null);
      };
    }));
    const slot = renderSlot(app.navPanels![0]!, { subPath: "" }, {
      rpc: { overview: () => structuredClone(data), poolUse },
    });
    await slot.findByRole("tablist", { name: "Subscriptions" });
    fireEvent.click(slot.getByRole("tab", { name: new RegExp(provider === "codex" ? "Codex" : "Claude") }));
    const picker = slot.getByRole("button", { name: `Switch machine ${provider === "codex" ? "Codex" : "Claude"} account` });
    fireEvent.keyDown(picker, { key: "Enter" });
    const menu = await slot.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "other@example.com" })).toBeTruthy();
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(slot.queryByRole("menu")).toBeNull());
    fireEvent.keyDown(picker, { key: "Enter" });
    const opened = await slot.findByRole("menu");
    expect(slot.queryByRole("button", { name: "Use current@example.com on this machine" })).toBeNull();
    fireEvent.click(within(opened).getByRole("menuitem", { name: "other@example.com" }));
    expect(poolUse).toHaveBeenCalledWith({ id: "other" });
    expect((picker as HTMLButtonElement).disabled).toBe(true);
    expect((slot.getByRole("button", { name: "Use other@example.com on this machine" }) as HTMLButtonElement).disabled).toBe(true);
    finish!();
    await waitFor(() => expect(slot.getByRole("button", { name: "Use current@example.com on this machine" })).toBeTruthy());
    expect(slot.queryByRole("button", { name: "Use other@example.com on this machine" })).toBeNull();
    expect(slot.inspection.rpcCalls.map((call) => call.method)).not.toContain("poolToggle");
    expect(slot.inspection.rpcCalls.map((call) => call.method)).not.toContain("poolRouting");
  });

  it("shows Codex windows from the current pool contract and hides unreported windows", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const view = fixture(ready);
    const account = {
      id: "codex-pool",
      provider: "codex",
      label: "Codex",
      email: "test@example.com",
      subscriptionType: "Pro",
      enabled: true,
      status: "ready",
      fiveHourUtilization: null,
      fiveHourResetAt: null,
      sevenDayUtilization: null,
      sevenDayResetAt: null,
      heldUntil: null,
      error: null,
      quotaMetrics: [
        {
          label: "Weekly window",
          used: 10,
          remaining: 90,
          limit: 100,
          unit: "percent",
          resetAt: now + 86400000,
          windowMs: 604800000,
        },
      ],
    };
    const slot = renderSlot(
      app.navPanels[0],
      { subPath: "" },
      {
        rpc: {
          overview: () => ({
            ...view,
            pool: {
              ...view.pool,
              enabled: true,
              accounts: [account],
              localLogin: { claude: null, codex: null },
            },
          }),
        },
      },
    );
    fireEvent.click(await slot.findByRole("tab", { name: "All" }));
    const quotas = within(slot.getByRole("region", { name: "Codex quotas" }));
    expect(quotas.getByText("10% used")).toBeTruthy();
    expect(quotas.getByText("90% left")).toBeTruthy();
    expect(quotas.queryByText(/usage not reported/)).toBeNull();
    expect(quotas.queryByText("5-hour window")).toBeNull();
    fireEvent.click(slot.getByRole("tab", { name: /^Codex/ }));
    expect(slot.getByText("10% used")).toBeTruthy();
  });
  it.each(["claude", "codex"] as const)(
    "keeps pooled %s CLI allowances visible in All without duplicating base windows",
    async (provider) => {
      const app = await loadPluginApp(() => import("./app"));
      const base = fixture(ready);
      const usage: AccountUsage = {
        ...ready,
        status: "error",
        error: "CLI quota request failed",
        metrics: [
          { ...ready.metrics[0], label: "5-hour window" },
          { ...ready.metrics[0], label: "Weekly window" },
          ...(provider === "claude"
            ? [
                { ...ready.metrics[0], label: "Fable · weekly" },
                {
                  label: "Extra usage",
                  used: 2,
                  limit: 20,
                  remaining: 18,
                  unit: "usd" as const,
                  resetAt: null,
                },
              ]
            : [
                {
                  label: "Credit balance",
                  used: null,
                  limit: null,
                  remaining: 400,
                  unit: "credits" as const,
                  resetAt: null,
                },
              ]),
        ],
      };
      const view = {
        ...base,
        pool: {
          ...base.pool,
          enabled: true,
          accounts: [
            {
              id: "pool-test",
              provider,
              label: "Test account",
              email: "test@example.com",
              subscriptionType: "Pro",
              enabled: true,
              status: "ready",
              fiveHourUtilization: 0.3,
              fiveHourResetAt: now + 3600000,
              sevenDayUtilization: 0.4,
              sevenDayResetAt: now + 86400000,
              heldUntil: null,
              error: null,
            },
          ],
          localLogin: {
            ...base.pool.localLogin,
            [provider]: { email: "test@example.com", plan: "Pro", inStack: true, usage },
          },
        },
      };
      const slot = renderSlot(app.navPanels[0], { subPath: "" }, { rpc: { overview: () => view } });
      fireEvent.click(await slot.findByRole("tab", { name: "All" }));
      const quotas = within(
        slot.getByRole("region", { name: `${provider === "claude" ? "Claude" : "Codex"} quotas` }),
      );
      expect(quotas.getAllByText("5-hour window")).toHaveLength(1);
      expect(quotas.getAllByText("Weekly window")).toHaveLength(1);
      expect(quotas.getByText(/CLI quota request failed · Last known usage/)).toBeTruthy();
      if (provider === "claude") {
        expect(quotas.getByText("Fable · weekly")).toBeTruthy();
        expect(quotas.getByText("Extra usage")).toBeTruthy();
        expect(quotas.getByText("$2.00 / $20.00")).toBeTruthy();
      } else {
        expect(quotas.getByText("Credit balance")).toBeTruthy();
        expect(quotas.getByText("400 credits left")).toBeTruthy();
      }
    },
  );
  it("combines usage in All, changes period and metric, and opens provider details", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const today = new Date(now).toISOString().slice(0, 10);
    const yesterday = new Date(now - 86400000).toISOString().slice(0, 10);
    const codex = {
      ...emptyHistory(),
      status: "ready",
      timeZone: "UTC",
      days: [
        { date: today, tokens: 1000, events: 1, costUsd: 1, estimated: true },
        { date: yesterday, tokens: 2000, events: 1, costUsd: 2, estimated: true },
      ],
    };
    const refresh = vi.fn(() => null);
    const slot = renderSlot(
      app.navPanels[0],
      { subPath: "" },
      {
        rpc: {
          overview: () => ({ ...fixture(ready), history: { codex } }),
          historyRefresh: refresh,
          usageRefresh: refresh,
          localUsageRefresh: refresh,
        },
      },
    );
    fireEvent.click(await slot.findByRole("tab", { name: "All" }));
    expect(slot.getByTestId("all-usage-total").textContent).toBe("~$3.00");
    expect(slot.getByRole("img", { name: "Cost share by provider for 30 Days" })).toBeTruthy();
    expect(slot.getByText(/not your subscription bill/)).toBeTruthy();
    const period = slot.getByRole("group", { name: "Usage period" });
    fireEvent.click(within(period).getByRole("button", { name: "Today" }));
    expect(slot.getByTestId("all-usage-total").textContent).toBe("~$1.00");
    fireEvent.click(within(period).getByRole("button", { name: "Yesterday" }));
    fireEvent.change(slot.getByRole("combobox", { name: "Usage metric" }), { target: { value: "tokens" } });
    expect(slot.getByTestId("all-usage-total").textContent).toBe("2K");
    fireEvent.click(slot.getByRole("button", { name: "Refresh all" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(5));
    expect(slot.getByRole("region", { name: "Antigravity quotas" }).textContent).toContain("75% used");
    fireEvent.click(
      within(slot.getByRole("list", { name: "Usage by provider" })).getByRole("button", { name: /Codex/ }),
    );
    expect(slot.getByRole("tab", { name: "Codex" }).getAttribute("aria-selected")).toBe("true");
  });
  it("ranks providers and donut slices by the selected total, including unpriced tokens", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const view = fixture(ready);
    const slot = renderSlot(
      app.navPanels[0],
      { subPath: "" },
      {
        rpc: {
          overview: () => ({
            ...view,
            history: {
              claude: aggregateHistory([{ id: "a", model: "test", at: now, tokens: 2000, costUsd: 8 }], now),
              codex: aggregateHistory([{ id: "b", model: "test", at: now, tokens: 3000, costUsd: 2 }], now),
              grok: aggregateHistory(
                [
                  {
                    id: "c",
                    model: "test",
                    at: now,
                    tokens: 4000,
                    costUsd: null,
                  },
                ],
                now,
              ),
            },
          }),
        },
      },
    );
    fireEvent.click(await slot.findByRole("tab", { name: "All" }));
    const legend = within(slot.getByRole("list", { name: "Usage by provider" }));
    const order = () =>
      legend
        .getAllByRole("button")
        .map((button) => button.textContent!.match(/Claude|Codex|Grok|Cursor|Antigravity/)![0]);
    expect(order()).toEqual(["Claude", "Codex", "Grok", "Cursor", "Antigravity"]);
    expect(legend.getByText("80.0%")).toBeTruthy();
    expect(legend.getByText("20.0%")).toBeTruthy();
    const chart = slot.getByRole("img", {
      name: "Cost share by provider for 30 Days",
    });
    const slices = () => Array.from(chart.querySelectorAll("circle[stroke-dasharray]"));
    expect(slices().map((slice) => slice.textContent?.split(":")[0])).toEqual(["Claude", "Codex"]);
    for (const [i, slice] of slices().entries()) {
      const [arc, gap] = slice.getAttribute("stroke-dasharray")!.split(" ").map(Number);
      expect(arc).toBeCloseTo(i === 0 ? 79.2 : 19.2);
      expect(arc + gap).toBeCloseTo(100);
    }
    expect(chart.parentElement?.contains(slot.getByText("Available history"))).toBe(false);
    fireEvent.change(slot.getByRole("combobox", { name: "Usage metric" }), {
      target: { value: "tokens" },
    });
    expect(order()).toEqual(["Grok", "Codex", "Claude", "Cursor", "Antigravity"]);
    expect(slices().map((slice) => slice.textContent?.split(":")[0])).toEqual(["Grok", "Codex", "Claude"]);
    expect(legend.getByText("44.4%")).toBeTruthy();
    expect(slot.getByTestId("all-usage-total").textContent).toBe("9K");
  });
  it("keeps the All chart empty when history is unavailable and supports tab keyboard navigation", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.navPanels[0], { subPath: "" }, { rpc: { overview: () => fixture(ready) } });
    const first = await slot.findByRole("tab", { name: /Antigravity/ });
    fireEvent.keyDown(first, { key: "Home" });
    expect(slot.getByRole("tab", { name: "All" }).getAttribute("aria-selected")).toBe("true");
    expect(slot.getByTestId("all-usage-total").textContent).toBe("—");
    expect(slot.getByText("History unavailable")).toBeTruthy();
    expect(slot.getByText(/No history could be loaded/)).toBeTruthy();
  });
  it("shows scan completion and identifies OpenUsage's record-size warning", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const history = aggregateHistory([{ id: null, at: now, model: "test", tokens: 100, costUsd: 1 }], now);
    history.partial = true;
    history.scan = { files: 9, oversizedRecords: 2, unreadableFiles: 0 };
    const slot = renderSlot(
      app.navPanels[0],
      { subPath: "" },
      {
        rpc: {
          overview: () => ({
            ...fixture(ready),
            history: { codex: history, claude: emptyHistory(), grok: emptyHistory() },
          }),
        },
      },
    );
    await slot.findByText("75% used");
    fireEvent.click(slot.getByRole("tab", { name: "Codex" }));
    expect(slot.getByText(/Full history scan complete/)).toBeTruthy();
    expect(slot.getByText(/Skipped 2 records over OpenUsage’s 1 MB limit/)).toBeTruthy();
  });
  it("labels API estimates in summaries, chart values and model costs", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const history = aggregateHistory(
      [
        {
          id: null,
          at: now,
          model: "gpt-6.1-sol",
          tokens: 11100,
          costUsd: 0.004,
        },
      ],
      now,
    );
    history.days.at(-1)!.estimated = true;
    history.models[0].estimated = true;
    history.pricingAsOf = now;
    const slot = renderSlot(
      app.navPanels[0],
      { subPath: "" },
      {
        rpc: {
          overview: () => ({
            ...fixture(ready),
            history: {
              codex: history,
              claude: emptyHistory(),
              grok: emptyHistory(),
            },
          }),
        },
      },
    );
    await slot.findByText("75% used");
    fireEvent.click(slot.getByRole("tab", { name: "Codex" }));
    const totals = within(slot.getByText("Today").closest("dl")!);
    expect(totals.getAllByTitle("Estimated at current API prices")).toHaveLength(2);
    expect(totals.getAllByText("~$0.00 · 11.1K tokens")).toHaveLength(2);
    expect(slot.getByText(/Estimated at current API prices, including cache rates/)).toBeTruthy();
    expect(slot.queryByText("Cost not reported")).toBeNull();
    expect(slot.queryByText("Price unavailable")).toBeNull();
  });
  it("shows calendar trends, honest totals, model shares, daily values and refresh", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const refresh = vi.fn(async () => null);
    const history = aggregateHistory(
      [
        {
          id: null,
          at: now,
          model: "test-model",
          tokens: 900_000,
          costUsd: null,
        },
        {
          id: null,
          at: now - 86_400_000,
          model: "other-model",
          tokens: 21_000,
          costUsd: 0.67,
        },
      ],
      now,
    );
    const slot = renderSlot(
      app.navPanels[0],
      { subPath: "" },
      {
        rpc: {
          overview: () => ({
            ...fixture(ready),
            history: {
              claude: emptyHistory(),
              codex: history,
              grok: emptyHistory(),
            },
          }),
          historyRefresh: refresh,
        },
      },
    );
    await slot.findByText("75% used");
    fireEvent.click(slot.getByRole("tab", { name: "Codex" }));
    expect(slot.getByText(/Shared CLI records/)).toBeTruthy();
    const totals = within(slot.getByText("Yesterday").closest("dl")!);
    expect(totals.getByText("$0.67 · 21K tokens")).toBeTruthy();
    expect(totals.getByText("Price unavailable")).toBeTruthy();
    expect(totals.getByText("$0.67 (partial) · 921K tokens")).toBeTruthy();
    expect(
      slot.getByRole("img", {
        name: "Daily token usage over the last 30 days",
      }),
    ).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "7 days" }));
    expect(slot.getByRole("img", { name: "Daily token usage over the last 7 days" })).toBeTruthy();
    fireEvent.click(slot.getByText("Daily totals"));
    expect(slot.getByRole("table").querySelectorAll("tbody tr")).toHaveLength(7);
    expect(slot.getByText("test-model")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Refresh history for Codex" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledWith({ provider: "codex" }));
    expect(slot.getByRole("link", { name: "Status" }).getAttribute("href")).toBe(
      "https://status.openai.com/",
    );
    slot.lifecycle.unmount();
  });

  it("retains stale trends and labels partial records and source errors", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const history = {
      ...aggregateHistory([{ id: null, at: now, model: "model", tokens: 12, costUsd: null }], now),
      status: "error" as const,
      partial: true,
      error: "Could not read usage records.",
    };
    const slot = renderSlot(
      app.navPanels[0],
      { subPath: "" },
      {
        rpc: {
          overview: () => ({
            ...fixture(ready),
            history: {
              claude: emptyHistory(),
              codex: history,
              grok: emptyHistory(),
            },
          }),
        },
      },
    );
    await slot.findByText("75% used");
    fireEvent.click(slot.getByRole("tab", { name: "Codex" }));
    expect(slot.getByRole("img")).toBeTruthy();
    expect(slot.getByText(/Partial records/)).toBeTruthy();
    expect(slot.getByText(/Could not read usage records.*Showing the last successful reading/)).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("does not relabel yesterday’s stale records as today after midnight", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const yesterday = new Date(2026, 8, 28, 12).getTime();
    const history = {
      ...aggregateHistory(
        [
          {
            id: null,
            at: yesterday,
            model: "model",
            tokens: 900,
            costUsd: 0.67,
          },
        ],
        yesterday,
      ),
      status: "error" as const,
      error: "Offline",
    };
    const slot = renderSlot(
      app.navPanels[0],
      { subPath: "" },
      {
        rpc: {
          overview: () => ({
            ...fixture(ready),
            now: new Date(2026, 8, 29, 12).getTime(),
            history: {
              claude: emptyHistory(),
              codex: history,
              grok: emptyHistory(),
            },
          }),
        },
      },
    );
    await slot.findByText("75% used");
    fireEvent.click(slot.getByRole("tab", { name: "Codex" }));
    expect(within(slot.getByText("Today").parentElement!).getByText("No data")).toBeTruthy();
    expect(within(slot.getByText("Yesterday").parentElement!).getByText("$0.67 · 900 tokens")).toBeTruthy();
    slot.lifecycle.unmount();
  });
  it("shows used quota, remaining allowance and explicit reset countdowns", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const refresh = vi.fn(async () => null);
    const slot = renderSlot(
      app.navPanels[0],
      { subPath: "" },
      { rpc: { overview: () => fixture(ready), usageRefresh: refresh } },
    );
    await slot.findByText("75% used");
    expect(slot.getByText("25% left")).toBeTruthy();
    expect(slot.getByText("Resets in 1h 0m")).toBeTruthy();
    expect(slot.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("75");
    fireEvent.click(slot.getByRole("button", { name: "Refresh usage for test-account" }));
    await waitFor(() =>
      expect(refresh).toHaveBeenCalledWith({
        provider: "antigravity",
        name: "test-account",
      }),
    );
    slot.lifecycle.unmount();
  });

  it("keeps stale usage visible with the fetch error", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      app.navPanels[0],
      { subPath: "" },
      {
        rpc: {
          overview: () =>
            fixture({
              ...ready,
              status: "error",
              error: "Usage service unavailable. Refresh to retry.",
            }),
        },
      },
    );
    await slot.findByText("75% used");
    expect(slot.getByText(/Last known usage/)).toBeTruthy();
    expect(slot.getByText(/Showing the last successful reading/)).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("shows loading and unavailable quota without inventing zero usage", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      app.navPanels[0],
      { subPath: "" },
      { rpc: { overview: () => fixture(emptyUsage()) } },
    );
    await slot.findByText("Fetching subscription usage…");
    expect(slot.queryByRole("progressbar")).toBeNull();
    slot.lifecycle.unmount();
    const unavailable = renderSlot(
      app.navPanels[0],
      { subPath: "" },
      {
        rpc: {
          overview: () => fixture({ ...emptyUsage(), status: "unavailable", fetchedAt: now }),
        },
      },
    );
    await unavailable.findByText(/The provider did not report usage/);
    expect(unavailable.queryByText("0% used")).toBeNull();
    unavailable.lifecycle.unmount();
  });

  it("renders model quota rows when plan metrics are empty and ready", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const modelOnly: AccountUsage = {
      ...emptyUsage(),
      status: "ready",
      plan: "Pro",
      fetchedAt: now,
      metrics: [],
      modelQuotas: [
        {
          label: "Gemini Pro",
          used: null,
          remaining: 25,
          limit: 100,
          unit: "percent",
          resetAt: now + 3_600_000,
          scope: { kind: "model", model: "pro" },
        },
      ],
    };
    const slot = renderSlot(app.navPanels[0], { subPath: "" }, { rpc: { overview: () => fixture(modelOnly) } });
    expect(await slot.findByText("Gemini Pro")).toBeTruthy();
    expect(slot.getByText("25% left")).toBeTruthy();
    expect(slot.queryByText(/Usage could not be loaded/)).toBeNull();
    fireEvent.click(slot.getByRole("tab", { name: "All" }));
    const quotas = within(slot.getByRole("region", { name: "Antigravity quotas" }));
    expect(quotas.getByText("Gemini Pro")).toBeTruthy();
    expect(quotas.getByText("25% left")).toBeTruthy();
    expect(quotas.queryByText(/Quota unavailable/)).toBeNull();
    slot.lifecycle.unmount();
  });

  it("keeps Cancel available while verifying a re-login", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const loginCancel = vi.fn(async () => null);
    const loginStart = vi.fn(async () => ({
      id: "verify-session",
      provider: "antigravity",
      targetAccount: "test-account",
      status: "verifying",
      url: "https://accounts.google.com/test",
      userCode: null,
      needsCode: true,
      expiresAt: now + 58_000,
      error: null,
      account: null,
    }));
    const slot = renderSlot(app.navPanels[0], { subPath: "" }, {
      rpc: { overview: () => fixture(ready), loginStart, loginCancel },
    });
    fireEvent.click(await slot.findByRole("button", { name: "Log in again for test-account" }));
    expect(await slot.findByText(/Saving the login|Signing in/)).toBeTruthy();
    const cancel = slot.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);
    fireEvent.click(cancel);
    expect(await slot.findByText("Sign-in cancelled. Your saved accounts were kept.")).toBeTruthy();
    expect(loginCancel).toHaveBeenCalledTimes(1);
    expect(slot.getByRole("button", { name: "Log in again for test-account" })).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("shows local Codex usage while the pooler is disabled", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const refresh = vi.fn(async () => null);
    const slot = renderSlot(
      app.navPanels[0],
      { subPath: "" },
      { rpc: { overview: () => fixture(ready), localUsageRefresh: refresh } },
    );
    await slot.findByText("75% used");
    fireEvent.click(slot.getByRole("tab", { name: "Codex" }));
    expect(slot.getByText("75% used")).toBeTruthy();
    fireEvent.click(
      slot.getByRole("button", {
        name: "Refresh usage for machine Codex login",
      }),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalledWith({ provider: "codex" }));
    slot.lifecycle.unmount();
  });
});
