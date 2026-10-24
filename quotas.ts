import type { ProviderId } from "./providers.js";
import { quotaPace, USAGE_TTL_MS, type AccountUsage, type UsageMetric } from "./usage-types.js";

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
  /** A reading was still loading when the report was made; limits come from the previous reading. */
  loading?: boolean;
  error: string | null;
  limits: (UsageMetric & { lastKnownRemaining: number | null })[];
}

export interface QuotaReport {
  now: number;
  accounts: QuotaAccount[];
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
    ...(usage.refreshing ? { loading: true } : {}),
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
  return lines.join("\n");
}

// ── Agent summary ─────────────────────────────────────────────────────────
// One row per account and quota scope, with the limit that binds it, so an
// agent can choose an account without reading every window.

/** Below this share left, an account is reported as almost out. */
export const LOW_PERCENT = 10;

export interface QuotaRow {
  provider: ProviderId;
  account: string;
  inUse: boolean;
  /** `all` is the account's own limit; `group:`, `feature:` and `models` also count the account limit. */
  scope: string;
  /** Percent left when known; null when unknown or the limit has no percent. */
  percentLeft: number | null;
  left: string;
  runway: "out" | "runs_out" | "lasts" | "unknown";
  runsOutAt: number | null;
  resetsAt: number | null;
  limitedBy: string | null;
}

export interface QuotaAttention {
  provider: ProviderId;
  account: string;
  issue: string;
  next: string;
}

export interface QuotaPick {
  provider: ProviderId;
  account: string;
  inUse: boolean;
  why: string;
}

export interface QuotaSummary {
  rows: QuotaRow[];
  attention: QuotaAttention[];
  pick: QuotaPick[];
}

type Limit = QuotaAccount["limits"][number];

const percentOf = (row: Limit, value: number | null) =>
  value === null ? null : row.unit === "percent" ? value : row.limit ? (value / row.limit) * 100 : null;

function scopeRow(account: QuotaAccount, scope: string, rows: Limit[], now: number): QuotaRow {
  const current = rows.filter((row) => row.remaining !== null);
  const measured = current.filter((row) => percentOf(row, row.remaining) !== null);
  const binding = measured.length
    ? measured.reduce((low, row) => (percentOf(row, row.remaining)! < percentOf(low, low.remaining)! ? row : low))
    : (current[0] ?? null);
  const percent = binding ? percentOf(binding, binding.remaining) : null;
  const lastKnown = rows.find((row) => row.lastKnownRemaining !== null);
  const left =
    binding && percent !== null
      ? `${Math.floor(percent)}%`
      : binding
        ? amount(binding.remaining, binding.unit)
        : lastKnown
          ? `unknown (last ${lastKnown.unit === "percent" ? `${Math.floor(lastKnown.lastKnownRemaining!)}%` : amount(lastKnown.lastKnownRemaining, lastKnown.unit)})`
          : "unknown";
  let runway: QuotaRow["runway"] = "unknown";
  let runsOutAt: number | null = null;
  if (measured.some((row) => percentOf(row, row.remaining)! <= 0)) runway = "out";
  else if (measured.length) {
    const paces = measured.map((row) => quotaPace(row, now));
    const ends = paces.flatMap((pace) => (pace?.limitIn != null ? [now + pace.limitIn] : []));
    if (ends.length) {
      runway = "runs_out";
      runsOutAt = Math.min(...ends);
    } else if (paces.every((pace) => pace !== null)) runway = "lasts";
  }
  const resetsAt = runway === "out"
    ? Math.max(...measured.filter((row) => percentOf(row, row.remaining)! <= 0).map((row) => row.resetAt ?? -1))
    : (binding?.resetAt ?? null);
  return {
    provider: account.provider,
    account: account.account,
    inUse: account.active,
    scope,
    percentLeft: percent,
    left,
    runway,
    runsOutAt,
    resetsAt: resetsAt !== null && resetsAt >= 0 ? resetsAt : null,
    limitedBy: binding?.label ?? null,
  };
}

export function summarizeQuotas(report: QuotaReport): QuotaSummary {
  const rows: QuotaRow[] = [];
  const attention: QuotaAttention[] = [];
  const refresh = (account: QuotaAccount) => `bb subs quota ${account.provider} --refresh`;
  for (const account of report.accounts) {
    const shared = account.limits.filter((row) => !row.scope);
    const scoped = new Map<string, Limit[]>();
    for (const row of account.limits) {
      if (!row.scope) continue;
      const key = row.scope.kind === "group" ? `group:${row.scope.group}` : row.scope.kind === "feature" ? `feature:${row.scope.feature}` : "models";
      scoped.set(key, [...(scoped.get(key) ?? []), row]);
    }
    const own: QuotaRow[] = [];
    if (shared.length || !scoped.size) own.push(scopeRow(account, "all", shared, report.now));
    for (const [scope, limits] of scoped) {
      const row = scopeRow(account, scope, [...limits, ...shared], report.now);
      // A group held down by the account limit says nothing the `all` row does not.
      if (!own.length || !shared.some((limit) => limit.label === row.limitedBy)) own.push(row);
    }
    rows.push(...own);

    const loginLost = /sign in|log in|login|expired|unauthori[sz]ed|re-?auth/i.test(account.error ?? "");
    if (account.loading && account.retrievedAt === null) {
      attention.push({ provider: account.provider, account: account.account, issue: "first reading still loading", next: "run the same command again in a minute" });
    } else if (account.status === "error") {
      attention.push({
        provider: account.provider,
        account: account.account,
        issue: `error: ${account.error ?? "unknown"}`,
        next: loginLost ? "the owner logs in again on the Subscription Accounts page" : refresh(account),
      });
    } else if (account.status === "unavailable") {
      attention.push({ provider: account.provider, account: account.account, issue: "provider reports no quota for this login", next: "none" });
    } else if (account.stale) {
      attention.push({
        provider: account.provider,
        account: account.account,
        issue: account.loading ? "new reading did not finish in time; last reading shown as unknown" : `reading is old (from ${iso(account.retrievedAt) ?? "unknown"})`,
        next: refresh(account),
      });
    }
    for (const row of own) {
      if (row.runway === "out") {
        attention.push({ provider: row.provider, account: row.account, issue: `${row.scope} out until ${iso(row.resetsAt) ?? "unknown"} (${row.limitedBy})`, next: row.inUse ? `bb subs use ${row.provider} <another account>` : "none" });
      } else if (row.percentLeft !== null && row.percentLeft < LOW_PERCENT) {
        attention.push({ provider: row.provider, account: row.account, issue: `${row.scope} almost out: ${row.left} left (${row.limitedBy})`, next: row.inUse ? `bb subs use ${row.provider} <another account>` : "none" });
      } else if (row.runway === "runs_out" && row.inUse) {
        attention.push({ provider: row.provider, account: row.account, issue: `${row.scope} runs out ${iso(row.runsOutAt) ?? "unknown"} at the current pace, before its reset`, next: "plan a switch before then" });
      }
    }
  }

  // Per provider: the ready account with the most left on its own limit; a
  // near-tie keeps the account in use (a switch moves every thread), then
  // prefers the sooner reset, because quota left at a reset is lost.
  const pick: QuotaPick[] = [];
  for (const provider of [...new Set(report.accounts.map((account) => account.provider))]) {
    const main = report.accounts
      .filter((account) => account.provider === provider)
      .flatMap((account) => {
        const own = rows.filter((row) => row.provider === provider && row.account === account.account);
        const row = own.find((r) => r.scope === "all" && r.percentLeft !== null)
          ?? own.filter((r) => r.percentLeft !== null).sort((a, b) => a.percentLeft! - b.percentLeft!)[0];
        return row && row.percentLeft! >= LOW_PERCENT && row.runway !== "out" ? [row] : [];
      });
    const ranked = main.sort((a, b) =>
      Math.abs(a.percentLeft! - b.percentLeft!) > 5
        ? b.percentLeft! - a.percentLeft!
        : a.inUse !== b.inUse
          ? Number(b.inUse) - Number(a.inUse)
          : (a.resetsAt ?? Infinity) - (b.resetsAt ?? Infinity),
    );
    const top = ranked[0];
    if (top) pick.push({ provider, account: top.account, inUse: top.inUse, why: `${top.left} left${top.resetsAt ? `, resets ${iso(top.resetsAt) ?? "unknown"}` : ""}` });
  }
  return { rows, attention, pick };
}

/** TOON-style cell: quoted only when it holds a comma, quote, colon or edge space. */
function cell(value: string | number | boolean | null): string {
  const text = value === null ? "none" : typeof value === "boolean" ? (value ? "yes" : "no") : String(value);
  return /[,":\n]|^\s|\s$|^$/.test(text) ? JSON.stringify(text) : text;
}

function table(name: string, columns: string[], data: (string | number | boolean | null)[][]): string[] {
  return [`${name}[${data.length}]{${columns.join(",")}}:`, ...data.map((row) => `  ${row.map(cell).join(",")}`)];
}

const iso = (value: number | null) => (value === null ? null : new Date(value).toISOString().replace(/\.\d{3}Z$/, "Z"));

/** Compact report for agents: one table of scopes, then what needs attention and which account to use. */
export function renderQuotaSummary(report: QuotaReport, summary = summarizeQuotas(report)): string {
  const lines = [`checkedAt: ${iso(report.now)}`];
  if (!report.accounts.length) return [...lines, "accounts: none saved", "help[1]:", "  Add one with `bb subs add <provider>`"].join("\n");
  lines.push(
    ...table(
      "quota",
      ["provider", "account", "inUse", "scope", "left", "runway", "resetsAt", "limitedBy"],
      summary.rows.map((row) => [
        row.provider,
        row.account,
        row.inUse,
        row.scope,
        row.left,
        row.runway === "runs_out" ? `runs out ${iso(row.runsOutAt)}` : row.runway === "lasts" ? "lasts to reset" : row.runway,
        iso(row.resetsAt),
        row.limitedBy,
      ]),
    ),
    ...table("attention", ["provider", "account", "issue", "next"], summary.attention.map((a) => [a.provider, a.account, a.issue, a.next])),
    ...table("pick", ["provider", "account", "inUse", "why"], summary.pick.map((p) => [p.provider, p.account, p.inUse, p.why])),
    "help[3]:",
    "  scope all is the account limit; a group or feature row also counts it. runway assumes steady use within each window",
    "  Run `bb subs quota --full` for every window, or `--json` for data; `--refresh` reads fresh quota",
    "  Switching an account with `bb subs use` moves every thread on this server",
  );
  return lines.join("\n");
}
