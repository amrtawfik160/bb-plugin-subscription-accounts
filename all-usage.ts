import type { UsageHistory, UsageTotals } from "./usage-types";

export type UsageProvider = "antigravity" | "claude" | "codex" | "cursor" | "grok";
export type UsagePeriod = "today" | "yesterday" | "30days";
export const USAGE_PROVIDERS: { id: UsageProvider; label: string; color: string }[] = [
  { id: "cursor", label: "Cursor", color: "var(--foreground)" },
  { id: "codex", label: "Codex", color: "#0b9f82" },
  { id: "grok", label: "Grok", color: "var(--muted-foreground)" },
  { id: "claude", label: "Claude", color: "#dc7956" },
  { id: "antigravity", label: "Antigravity", color: "var(--warning)" },
];

interface HistorySources {
  history?: Partial<Record<"claude" | "codex" | "grok", UsageHistory>>;
  swap: { id: UsageProvider; accounts: { usage: { history?: UsageHistory } }[] }[];
}

export function sumUsage(rows: UsageTotals[]): UsageTotals {
  const active = rows.filter((row) => row.events > 0);
  const priced = active.filter((row) => row.costUsd !== null);
  return {
    tokens: active.reduce((sum, row) => sum + row.tokens, 0),
    events: active.reduce((sum, row) => sum + row.events, 0),
    costUsd: priced.length ? priced.reduce((sum, row) => sum + row.costUsd!, 0) : active.length ? null : 0,
    estimated: active.some((row) => row.estimated),
    unpricedTokens: active.reduce(
      (sum, row) => sum + (row.unpricedTokens ?? (row.costUsd === null ? row.tokens : 0)),
      0,
    ),
  };
}

export function periodDates(now: number, period: UsagePeriod, timeZone = "UTC") {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  const today = `${part("year")}-${part("month")}-${part("day")}`;
  const offset = (days: number) => {
    const date = new Date(`${today}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() - days);
    return date.toISOString().slice(0, 10);
  };
  return period === "today"
    ? [today, today]
    : period === "yesterday"
      ? [offset(1), offset(1)]
      : [offset(29), today];
}

export function aggregateProviders(data: HistorySources, period: UsagePeriod, now: number) {
  return USAGE_PROVIDERS.map((provider) => {
    // Local CLI history spans all logins; Cursor exports belong to individual accounts.
    const sources =
      provider.id === "cursor"
        ? data.swap
            .filter((section) => section.id === "cursor")
            .flatMap((section) => section.accounts.map((a) => a.usage.history))
        : provider.id === "antigravity"
          ? []
          : [data.history?.[provider.id]];
    const histories = sources.filter((history): history is UsageHistory => !!history);
    const available = histories.filter(
      (history) => history.status === "ready" || history.days.some((day) => day.events > 0),
    );
    const rows = available.flatMap((history) => {
      const [start, end] = periodDates(now, period, history.timeZone);
      return history.days.filter((day) => day.date >= start && day.date <= end);
    });
    const days = [...new Set(rows.map((row) => row.date))].sort().map((date) => ({
      date,
      ...sumUsage(rows.filter((row) => row.date === date)),
    }));
    const excludedUnpricedTokens = available.reduce((sum, history) => sum + (history.unpricedTokens ?? 0), 0);
    return {
      ...provider,
      total: sumUsage(rows),
      days,
      available: available.length > 0,
      loading: histories.some((history) => history.status === "loading"),
      refreshing: histories.some((history) => history.refreshing),
      stale: available.some((history) => history.status === "error"),
      partial:
        histories.some((history) => history.partial) ||
        available.length < sources.length ||
        excludedUnpricedTokens > 0,
      excludedUnpricedTokens,
      fetchedAt:
        available.length && available.every((history) => history.fetchedAt !== null)
          ? Math.min(...available.map((history) => history.fetchedAt!))
          : null,
    };
  });
}
