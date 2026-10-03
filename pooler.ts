// Claude Code and Codex accounts live in bb's builtin Account Pooler, which
// routes their API traffic across accounts by quota. This module calls its
// plugin RPC so the page can manage those accounts next to the swap providers.
// Shapes mirror account-pool's own contract; unknown fields pass through.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import type { PoolProviderId } from "./providers.js";
import {
  metric,
  number,
  object,
  textValue,
  type UsageMetric,
} from "./usage.js";

export const POOLER_ID = "account-pool";

const accountSchema = z
  .object({
    id: z.string(),
    provider: z.enum(["claude", "codex"]),
    kind: z.string(),
    label: z.string(),
    email: z.string().nullable(),
    subscriptionType: z.string().nullable().optional(),
    enabled: z.boolean(),
    priority: z.number(),
    status: z.enum(["disabled", "ready", "held", "exhausted", "error"]),
    fiveHourUtilization: z.number().nullable().optional(),
    fiveHourResetAt: z.number().nullable().optional(),
    sevenDayUtilization: z.number().nullable().optional(),
    sevenDayResetAt: z.number().nullable().optional(),
    heldUntil: z.number().nullable().optional(),
    error: z.string().nullable().optional(),
    lastUsedAt: z.number().nullable().optional(),
    accountUuid: z.string().nullable().optional(),
    codexAccountId: z.string().nullable().optional(),
    observedAt: z.number().nullable().optional(),
  })
  .passthrough();

export type PoolAccount = z.infer<typeof accountSchema>;

export function poolQuotaMetrics(
  account: Record<string, unknown>,
): UsageMetric[] {
  const windows = Array.isArray(account.limitWindows) ? account.limitWindows : [];
  const rows: UsageMetric[] = [];
  if (windows.length) {
    for (const raw of windows) {
      const window = object(raw),
        minutes = number(window.windowMinutes),
        used = number(window.utilization);
      if (minutes === null || minutes <= 0) continue;
      const label =
        minutes === 300
          ? "5-hour window"
          : minutes === 10080
            ? "Weekly window"
            : minutes === 1440
              ? "Daily window"
              : `${minutes / 60}-hour window`;
      const row = metric(
        label,
        used === null ? null : used * 100,
        100,
        "percent",
        number(window.resetAt),
      );
      if (row && !rows.some((r) => r.label === label))
        rows.push({
          ...row,
          windowMs: minutes * 60000,
        });
    }
  } else {
    for (const [label, key, reset, seconds] of [
      ["5-hour window", "fiveHourUtilization", "fiveHourResetAt", 18000],
      ["Weekly window", "sevenDayUtilization", "sevenDayResetAt", 604800],
    ] as const) {
      const used = number(account[key]);
      const row = metric(
        label,
        used === null ? null : used * 100,
        100,
        "percent",
        number(account[reset]),
      );
      if (row) rows.push({ ...row, windowMs: seconds * 1000 });
    }
  }
  for (const [name, raw] of Object.entries(object(account.familyWeekly))) {
    const family = object(raw),
      used = number(family.utilization);
    const row = metric(
      `${name.charAt(0).toUpperCase()}${name.slice(1)} · weekly`,
      used === null ? null : used * 100,
      100,
      "percent",
      number(family.resetAt),
    );
    if (row) rows.push({ ...row, windowMs: 604800000 });
  }
  return rows;
}

export function poolAccountIdentity(account: PoolAccount): string | null {
  return textValue(
    account.provider === "claude"
      ? account.accountUuid
      : account.codexAccountId,
  );
}

const statusSchema = z
  .object({ routing: z.object({ claude: z.boolean(), codex: z.boolean() }) })
  .passthrough();

export interface PoolerView {
  installed: boolean;
  enabled: boolean;
  routing: { claude: boolean; codex: boolean };
  accounts: PoolAccount[];
  error: string | null;
}

export function pooler(bb: BbPluginApi) {
  function call<T>(method: string, input: unknown, outputSchema: z.ZodType<T>): Promise<T> {
    return bb.sdk.plugins.callRpc({
      pluginId: POOLER_ID,
      method,
      input: input as never,
      outputSchema,
    });
  }

  async function view(): Promise<PoolerView> {
    const empty: PoolerView = {
      installed: false,
      enabled: false,
      routing: { claude: false, codex: false },
      accounts: [],
      error: null,
    };
    const listed = await bb.sdk.plugins.list();
    const plugins = (Array.isArray(listed) ? listed : (listed as { plugins?: unknown[] }).plugins ?? []) as Array<{
      id: string;
      enabled: boolean;
    }>;
    const entry = plugins.find((plugin) => plugin.id === POOLER_ID);
    if (!entry) return empty;
    if (!entry.enabled) return { ...empty, installed: true };
    try {
      const [accounts, status] = await Promise.all([
        call("account.list", null, z.array(accountSchema)),
        call("status.get", null, statusSchema),
      ]);
      return { installed: true, enabled: true, routing: status.routing, accounts, error: null };
    } catch (error) {
      return { ...empty, installed: true, enabled: true, error: (error as Error).message };
    }
  }

  return {
    view,
    enable: () => bb.sdk.plugins.enable({ pluginId: POOLER_ID }),
    importLocal: (
      provider: PoolProviderId,
      priority: number,
      label: string | null = null,
    ) =>
      call(
        "account.add",
        { provider, source: { kind: "import" }, label, priority },
        accountSchema.extend({
          status: accountSchema.shape.status.default("ready"),
        }),
      ),
    remove: (id: string) => call("account.remove", { id }, z.object({ removed: z.boolean() })),
    setEnabled: (id: string, enabled: boolean) =>
      call(enabled ? "account.enable" : "account.disable", { id }, z.unknown()),
    reorder: (provider: PoolProviderId, accountIds: string[]) =>
      call("account.reorder", { provider, accountIds }, z.unknown()),
    refresh: (accountId: string) => call("account.refreshUsage", { accountId }, z.unknown()),
    setRouting: (provider: PoolProviderId, enabled: boolean) =>
      call("routing.set", { provider, enabled }, z.unknown()),
    claudeLoginStart: () =>
      call("login.start", null, z.object({ sessionId: z.string(), authorizeUrl: z.string() })),
    claudeLoginComplete: (sessionId: string, pasted: string) =>
      call("login.complete", { sessionId, pasted }, accountSchema),
    codexLoginStart: () =>
      call(
        "codexLogin.start",
        null,
        z.object({
          sessionId: z.string(),
          verificationUri: z.string(),
          userCode: z.string(),
          expiresAt: z.number(),
          intervalMs: z.number(),
        }),
      ),
    codexLoginPoll: (sessionId: string) =>
      call(
        "codexLogin.poll",
        { sessionId },
        z.union([
          z.object({ status: z.literal("pending") }),
          z.object({ status: z.literal("complete"), account: accountSchema }),
          z.object({ status: z.literal("error"), message: z.string() }),
        ]),
      ),
    codexLoginCancel: (sessionId: string) => call("codexLogin.cancel", { sessionId }, z.unknown()),
  };
}
