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
