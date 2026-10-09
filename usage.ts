import { z } from "zod";
import { historySchema } from "./history-schema.js";
import { USAGE_TTL_MS, type AccountUsage, type UsageData, type UsageMetric } from "./usage-types.js";
export { USAGE_TTL_MS } from "./usage-types.js";
export type { AccountUsage, UsageData, UsageMetric } from "./usage-types.js";

export const usageMetricSchema = z.object({
  label: z.string(),
  used: z.number().finite().nonnegative().nullable(),
  limit: z.number().finite().positive().nullable(),
  remaining: z.number().finite().nonnegative().nullable(),
  unit: z.enum(["percent", "usd", "requests", "credits"]),
  resetAt: z.number().finite().nullable(),
  windowMs: z.number().finite().positive().optional(),
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("model"), model: z.string() }),
    z.object({ kind: z.literal("group"), group: z.string() }),
    z.object({ kind: z.literal("feature"), feature: z.string() }),
  ]).optional(),
  derivedFromModels: z.boolean().optional(),
});

export const usageSchema = z.object({
  status: z.enum(["loading", "ready", "unavailable", "error"]),
  plan: z.string().nullable(),
  metrics: z.array(usageMetricSchema),
  fetchedAt: z.number().nullable(),
  refreshing: z.boolean(),
  error: z.string().nullable(),
  attemptedAt: z.number().optional(),
  modelQuotas: z.array(usageMetricSchema).optional(),
  history: historySchema.optional(),
});

export function emptyUsage(): AccountUsage {
  return {
    status: "loading",
    plan: null,
    metrics: [],
    fetchedAt: null,
    refreshing: false,
    error: null,
  };
}

interface UsageEntry {
  value: AccountUsage;
  attemptedAt: number;
  pending?: Promise<void>;
}

/** Cache only normalized metrics; credential material never enters the view. */
export class UsageCache {
  private entries = new Map<string, UsageEntry>();
  private disposed = false;

  constructor(
    private changed: () => void,
    private now = Date.now,
  ) {}

  get(key: string): AccountUsage {
    return this.entries.get(key)?.value ?? emptyUsage();
  }

  refresh(key: string, load: () => Promise<UsageData>, force = false): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const previous = this.entries.get(key);
    if (previous?.pending) return previous.pending;
    if (!force && previous && this.now() - previous.attemptedAt < USAGE_TTL_MS) return Promise.resolve();
    const entry: UsageEntry = {
      value: { ...(previous?.value ?? emptyUsage()), refreshing: true, attemptedAt: this.now() },
      attemptedAt: this.now(),
    };
    this.entries.set(key, entry);
    entry.pending = Promise.resolve()
      .then(load)
      .then((data) => {
        entry.value = usageSchema.parse({
          ...data,
          ...(data.history
            ? {
                history:
                  data.history.status === "error" && previous?.value.history?.days.length
                    ? { ...previous.value.history, status: "error", error: data.history.error }
                    : data.history,
              }
            : {}),
          status: data.metrics.length || data.modelQuotas?.length ? "ready" : "unavailable",
          fetchedAt: this.now(),
          attemptedAt: entry.attemptedAt,
          refreshing: false,
          error: null,
        });
      })
      .catch((cause: unknown) => {
        entry.value = {
          ...entry.value,
          status: "error",
          refreshing: false,
          error: cause instanceof UsageError ? cause.message : "Could not fetch usage. Refresh to try again.",
        };
      })
      .finally(() => {
        entry.pending = undefined;
        if (!this.disposed && this.entries.get(key) === entry) this.changed();
      });
    return entry.pending;
  }

  remove(key: string): void {
    this.entries.delete(key);
  }
  dispose(): void {
    this.disposed = true;
    this.entries.clear();
  }
}

export class UsageError extends Error {}

export function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function number(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function timestamp(value: unknown): number | null {
  const numeric = number(value);
  if (numeric !== null) return numeric > 0 ? (numeric < 1e12 ? numeric * 1000 : numeric) : null;
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

export function metric(
  label: string,
  used: number | null,
  limit: number | null,
  unit: UsageMetric["unit"],
  resetAt: number | null = null,
  remaining: number | null = null,
): UsageMetric | null {
  if (used === null && remaining === null) return null;
  return {
    label,
    used: used === null ? null : Math.max(0, used),
    limit: limit !== null && limit > 0 ? limit : null,
    remaining:
      remaining !== null
        ? Math.max(0, remaining)
        : used !== null && limit !== null && limit > 0
          ? Math.max(0, limit - used)
          : null,
    unit,
    resetAt,
  };
}

export function mapAntigravity(summary: unknown, models: unknown = null): UsageMetric[] {
  const envelope = object(summary);
  const groups = object(envelope.response).groups ?? envelope.groups;
  const labels: Record<string, string> = {
    "gemini-5h": "Gemini · 5 hours",
    "gemini-weekly": "Gemini · weekly",
    "3p-5h": "Claude · 5 hours",
    "3p-weekly": "Claude · weekly",
  };
  if (Array.isArray(groups)) {
    const buckets = groups.flatMap((group) =>
      Array.isArray(object(group).buckets) ? (object(group).buckets as unknown[]) : [],
    );
    return Object.entries(labels).flatMap(([id, label]) => {
      const bucket = buckets
        .map(object)
        .find((b) => b.bucketId === id && number(b.remainingFraction) !== null);
      if (!bucket) return [];
      const fraction = Math.max(0, Math.min(1, number(bucket.remainingFraction)!));
      return [{ ...metric(label, (1 - fraction) * 100, 100, "percent", timestamp(bucket.resetTime))!, scope: { kind: "group", group: id.startsWith("gemini") ? "Gemini" : "Claude" } }];
    });
  }
  const pools = new Map<string, UsageMetric>();
  for (const [id, raw] of Object.entries(object(object(models).models))) {
    const model = object(raw);
    const label = textValue(model.displayName ?? model.label);
    const quota = object(model.quotaInfo);
    const fraction = number(quota.remainingFraction);
    if (model.isInternal === true || !label || fraction === null) continue;
    const pool = /gemini/i.test(label + id) ? "Gemini · 5 hours" : "Claude · 5 hours";
    const row = metric(
      pool,
      (1 - Math.max(0, Math.min(1, fraction))) * 100,
      100,
      "percent",
      timestamp(quota.resetTime),
    )!;
    if (!pools.has(pool) || row.used! > pools.get(pool)!.used!) pools.set(pool, row);
  }
  return [...pools.values()].map((row) => ({ ...row, derivedFromModels: true }));
}

export function mapAntigravityModelQuotas(value: unknown): UsageMetric[] {
  return Object.entries(object(object(value).models)).flatMap(([id, raw]) => {
    const model = object(raw);
    const quota = object(model.quotaInfo);
    const fraction = number(quota.remainingFraction);
    if (model.isInternal === true || fraction === null) return [];
    const row = metric(textValue(model.displayName ?? model.label) ?? id, null, 100, "percent", timestamp(quota.resetTime), Math.max(0, Math.min(1, fraction)) * 100)!;
    return [{ ...row, scope: { kind: "model", model: id } }];
  });
}

export function mapCursor(
  usage: unknown,
  summary: unknown = null,
  requests: unknown = null,
  credits: unknown = null,
): UsageData {
  const root = object(usage),
    rest = object(summary);
  const individual = object(rest.individualUsage),
    team = object(rest.teamUsage);
  const plan = object(root.planUsage),
    restPlan = object(individual.plan);
  const resetAt = timestamp(root.billingCycleEnd ?? rest.billingCycleEnd);
  const rows: UsageMetric[] = [];
  const add = (row: UsageMetric | null) => {
    if (row) rows.push(row);
  };
  const limit = number(plan.limit),
    remaining = number(plan.remaining);
  const used = number(plan.totalSpend) ?? (limit !== null && remaining !== null ? limit - remaining : null);
  const request = object(object(requests)["gpt-4"]);
  if (root.enabled !== false) {
    if (limit !== null && limit > 0 && used !== null)
      add(metric("Plan usage", used / 100, limit / 100, "usd", resetAt));
    else if (number(plan.totalPercentUsed) !== null)
      add(metric("Plan usage", number(plan.totalPercentUsed), 100, "percent", resetAt));
    else if (number(request.maxRequestUsage) !== null && number(request.maxRequestUsage)! > 0)
      add(
        metric(
          "Included requests",
          number(request.numRequests ?? request.numRequestsTotal),
          number(request.maxRequestUsage),
          "requests",
          resetAt,
        ),
      );
    else if (number(restPlan.totalPercentUsed) !== null)
      add(metric("Plan usage", number(restPlan.totalPercentUsed), 100, "percent", resetAt));
    else {
      const bucket = object(rest.limitType === "team" ? team.pooled : (individual.overall ?? team.pooled));
      const bucketUsed = number(bucket.used),
        bucketLimit = number(bucket.limit);
      add(
        metric(
          "Plan usage",
          bucketUsed !== null ? bucketUsed / 100 : null,
          bucketLimit !== null ? bucketLimit / 100 : null,
          "usd",
          resetAt,
        ),
      );
    }
  }
  for (const [key, label] of [
    ["autoPercentUsed", "Cursor models"],
    ["apiPercentUsed", "Other models"],
  ]) {
    const row = metric(label, number(plan[key] ?? restPlan[key]), 100, "percent", resetAt);
    if (row) add({ ...row, scope: { kind: "group", group: label } });
  }
  const spend = object(root.spendLimitUsage);
  const spendLimit = number(spend.individualLimit ?? spend.pooledLimit);
  const spendRemaining = number(spend.individualRemaining ?? spend.pooledRemaining);
  const spendUsed =
    number(spend.individualUsed ?? spend.pooledUsed ?? spend.totalSpend) ??
    (spendLimit !== null && spendRemaining !== null ? spendLimit - spendRemaining : null);
  if (spendUsed !== null)
    add(metric("On-demand", spendUsed / 100, spendLimit !== null ? spendLimit / 100 : null, "usd", resetAt));
  else {
    const bucket = object(individual.onDemand ?? team.onDemand);
    const bucketUsed = number(bucket.used),
      bucketLimit = number(bucket.limit);
    if (bucket.enabled !== false)
      add(
        metric(
          "On-demand",
          bucketUsed !== null ? bucketUsed / 100 : null,
          bucketLimit !== null ? bucketLimit / 100 : null,
          "usd",
          resetAt,
        ),
      );
  }
  const grants = object(credits);
  const total = number(grants.totalCents),
    spent = number(grants.usedCents);
  if (grants.hasCreditGrants === true && total !== null && spent !== null)
    add(metric("Credit balance", null, null, "usd", null, (total - spent) / 100));
  return { plan: textValue(rest.membershipType), metrics: rows };
}

export function mapGrok(value: unknown): UsageMetric[] {
  const config = object(object(value).config),
    period = object(config.currentPeriod);
  const start = timestamp(period.start),
    end = timestamp(period.end);
  if (!textValue(period.type) || start === null || end === null || end <= start)
    throw new UsageError("Grok returned an unrecognized billing response. Refresh to try again.");
  const percent = number(config.creditUsagePercent);
  if (percent === null)
    throw new UsageError("Grok returned an invalid usage percentage. Refresh to try again.");
  const rows: UsageMetric[] = [];
  if (period.type === "USAGE_PERIOD_TYPE_WEEKLY")
    rows.push(metric("Weekly pool", Math.min(100, Math.max(0, percent)), 100, "percent", end)!);
  const cap = number(object(config.onDemandCap).val);
  // A cap alone is not consumed usage; show it as an allowance with unknown use.
  if (cap !== null && cap > 0)
    rows.push({
      label: "Pay-as-you-go cap",
      used: null,
      limit: cap,
      remaining: null,
      unit: "credits",
      resetAt: null,
    });
  return rows;
}

export function mapClaude(value: unknown): UsageData {
  const root = object(value);
  const metrics: UsageMetric[] = [];
  const labels: Record<string, string> = { five_hour: "5-hour window", seven_day: "Weekly window" };
  for (const key of Object.keys(root).filter(
    (key) => key === "five_hour" || key === "seven_day" || key.startsWith("seven_day_"),
  )) {
    const model = key.slice("seven_day_".length).replaceAll("_", " ");
    const label = labels[key] ?? `${model.charAt(0).toUpperCase()}${model.slice(1)} · weekly`;
    const window = object(root[key]);
    const row = metric(label, number(window.utilization), 100, "percent", timestamp(window.resets_at));
    if (row) metrics.push({ ...row, windowMs: (key === "five_hour" ? 5 : 168) * 3_600_000, ...(key.startsWith("seven_day_") ? { scope: { kind: "group", group: model } satisfies NonNullable<UsageMetric["scope"]> } : {}) });
  }
  const extra = object(root.extra_usage);
  if (extra.is_enabled === true) {
    const used = number(extra.used_credits),
      limit = number(extra.monthly_limit);
    const row = metric(
      "Extra usage",
      used === null ? null : used / 100,
      limit === null ? null : limit / 100,
      "usd",
    );
    if (row) metrics.push(row);
  }
  return { plan: null, metrics };
}

export function mapCodex(
  value: unknown,
  now = Date.now(),
  headers = new Headers(),
): UsageData {
  const root = object(value),
    rate = object(root.rate_limit);
  const metrics: UsageMetric[] = [];
  // OpenUsage's classifiedWindowLines: explicit periods take priority over slot fallbacks.
  function windows(
    rate: Record<string, unknown>,
    labels: [string, string],
    useHeaders = false,
  ) {
    const candidates = ["primary", "secondary"].flatMap((slot, index) => {
      const raw = rate[`${slot}_window`];
      const headerUsed = useHeaders
        ? number(headers.get(`x-codex-${slot}-used-percent`))
        : null;
      if (!raw && headerUsed === null) return [];
      const window = object(raw);
      const duration = number(window.limit_window_seconds);
      return [
        {
          window,
          duration,
          used: number(window.used_percent) ?? headerUsed,
          fallback: index,
        },
      ];
    });
    return [18000, 604800].flatMap((seconds, index) => {
      const candidate =
        candidates.find((c) => c.duration === seconds) ??
        candidates.find(
          (c) =>
            ![18000, 604800].includes(c.duration ?? 0) && c.fallback === index,
        );
      if (!candidate) return [];
      const after = number(candidate.window.reset_after_seconds);
      const row = metric(
        labels[index],
        candidate.used,
        100,
        "percent",
        timestamp(candidate.window.reset_at) ??
          (after === null ? null : now + after * 1000),
      );
      return row
        ? [{ ...row, windowMs: (candidate.duration ?? seconds) * 1000 }]
        : [];
    });
  }
  metrics.push(...windows(rate, ["5-hour window", "Weekly window"], true));
  for (const extra of Array.isArray(root.additional_rate_limits) ? root.additional_rate_limits : []) {
    const item = object(extra),
      extraRate = object(item.rate_limit);
    const name = textValue(item.limit_name ?? item.metered_feature);
    if (!name) continue;
    metrics.push(
      ...windows(extraRate, [`${name} · session`, `${name} · weekly`]).map((row) => ({ ...row, scope: { kind: "feature", feature: name } satisfies NonNullable<UsageMetric["scope"]> })),
    );
  }
  const credits = object(root.credits);
  const balance =
    number(credits.balance) ?? (credits.has_credits === false ? 0 : null) ??
    number(headers.get("x-codex-credits-balance"));
  if (balance !== null) metrics.push(metric("Credit balance", null, null, "credits", null, balance)!);
  return { plan: textValue(root.plan_type), metrics };
}
