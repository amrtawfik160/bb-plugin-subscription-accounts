import type { ProviderId } from "./providers.js";
import { USAGE_TTL_MS, type AccountUsage, type UsageMetric } from "./usage-types.js";

export interface QuotaAccount {
  provider: ProviderId;
  account: string;
  email: string | null;
  active: boolean;
  plan: string | null;
  status: AccountUsage["status"];
  checkedAt: number | null;
  retrievedAt: number | null;
  stale: boolean;
  error: string | null;
  limits: (UsageMetric & { lastKnownRemaining: number | null })[];
}

export interface ModelCatalog {
  provider: ProviderId;
  status: "ready" | "unknown";
  models: { id: string; label: string }[];
}

export interface QuotaReport {
  now: number;
  accounts: QuotaAccount[];
  catalogs: ModelCatalog[];
}

export function quotaAccount(
  target: Pick<QuotaAccount, "provider" | "account" | "email" | "active">,
  usage: AccountUsage,
  now: number,
): QuotaAccount {
  const stale = usage.fetchedAt === null || now - usage.fetchedAt >= USAGE_TTL_MS;
  const current = usage.status === "ready" && !stale;
  return {
    ...target,
    plan: usage.plan,
    status: usage.status,
    checkedAt: usage.attemptedAt ?? null,
    retrievedAt: usage.fetchedAt,
    stale,
    error: usage.error,
    limits: [...usage.metrics.filter((row) => !row.derivedFromModels), ...(usage.modelQuotas ?? [])].map((row) => ({
      ...row,
      remaining: current ? row.remaining : null,
      lastKnownRemaining: current ? null : row.remaining,
    })),
  };
}

const at = (value: number | null) => value === null ? "unknown" : new Date(value).toISOString();
const amount = (value: number | null, unit: UsageMetric["unit"]) => value === null ? "unknown" : `${Number(value.toFixed(4))} ${unit}`;

export function renderQuotas(report: QuotaReport): string {
  const lines = [`Quota checked at ${at(report.now)}.`, "Account and group limits are shared. Model quota is unknown unless the API reports it."];
  for (const account of report.accounts) {
    lines.push("", `${account.provider} / ${account.account}${account.email ? ` (${account.email})` : ""}${account.active ? " [in use]" : ""}`);
    lines.push(`  Plan: ${account.plan ?? "unknown"}. Status: ${account.status}${account.stale ? " (stale)" : ""}. Retrieved: ${at(account.retrievedAt)}. Checked: ${at(account.checkedAt)}.`);
    if (account.error) lines.push(`  ${account.error}`);
    if (!account.limits.length) lines.push("  Remaining: unknown. The API did not report quota.");
    for (const limit of account.limits) {
      const scope = limit.scope;
      const subject = !scope ? "account" : scope.kind === "model" ? `model ${scope.model}` : scope.kind === "group" ? `group ${scope.group}` : `feature ${scope.feature}`;
      lines.push(`  ${limit.label} [${subject}]: ${amount(limit.remaining, limit.unit)} left. Reset: ${at(limit.resetAt)}.${limit.lastKnownRemaining !== null ? ` Last known: ${amount(limit.lastKnownRemaining, limit.unit)}.` : ""}`);
    }
  }
  if (!report.accounts.length) lines.push("", "No saved accounts configured.");
  for (const catalog of report.catalogs) {
    lines.push("", `${catalog.provider} available models [${catalog.status}]: ${catalog.models.map((model) => `${model.id} (${model.label})`).join(", ") || "unknown"}`);
  }
  return lines.join("\n");
}
