export const USAGE_TTL_MS = 5 * 60_000;

export interface UsageMetric {
  label: string;
  used: number | null;
  limit: number | null;
  remaining: number | null;
  unit: "percent" | "usd" | "requests" | "credits";
  resetAt: number | null;
  windowMs?: number;
  scope?:
    | { kind: "model"; model: string }
    | { kind: "group"; group: string }
    | { kind: "feature"; feature: string };
  derivedFromModels?: boolean;
}

export interface AccountUsage {
  status: "loading" | "ready" | "unavailable" | "error";
  plan: string | null;
  metrics: UsageMetric[];
  fetchedAt: number | null;
  refreshing: boolean;
  error: string | null;
  attemptedAt?: number;
  modelQuotas?: UsageMetric[];
  history?: UsageHistory;
}

export type UsageData = Pick<AccountUsage, "plan" | "metrics" | "history" | "modelQuotas">;

export interface UsageTotals {
  tokens: number;
  costUsd: number | null;
  events: number;
  estimated?: boolean;
  unpricedTokens?: number;
}
export interface UsageHistory {
  status: "loading" | "ready" | "unavailable" | "error";
  source: "local" | "cursor";
  days: (UsageTotals & { date: string })[];
  models: (UsageTotals & { model: string })[];
  fetchedAt: number | null;
  refreshing: boolean;
  partial: boolean;
  error: string | null;
  timeZone?: string;
  pricingAsOf?: number;
  unpricedTokens?: number;
  unpricedModels?: string[];
  scan?: { files: number; oversizedRecords: number; unreadableFiles: number };
}

/** Pace assumes steady use within a fixed window; it is never measured history. */
export function quotaPace(row: UsageMetric, now: number) {
  if (!row.windowMs || !row.resetAt || !row.limit || row.used === null) return null;
  const elapsed = now - (row.resetAt - row.windowMs);
  if (elapsed < 15 * 60_000 || elapsed >= row.windowMs) return null;
  const expected = (elapsed / row.windowMs) * 100;
  const consumed = (row.used / row.limit) * 100;
  const remainingMs = consumed > 0 ? elapsed * ((100 - consumed) / consumed) : Infinity;
  return {
    expected,
    limitIn: remainingMs > 0 && now + remainingMs < row.resetAt ? remainingMs : null,
  };
}
