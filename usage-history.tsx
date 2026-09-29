import { useState } from "react";
import type { UsageHistory, UsageTotals } from "./usage-types";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const compact = (n: number) =>
  new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
const dollars = (n: number) =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
  }).format(n);
export function historyTotal(rows: UsageTotals[]): UsageTotals {
  const active = rows.filter((row) => row.events > 0);
  const priced = active.filter((row) => row.costUsd !== null);
  return {
    tokens: active.reduce((sum, row) => sum + row.tokens, 0),
    events: active.reduce((sum, row) => sum + row.events, 0),
    costUsd: priced.length ? priced.reduce((sum, row) => sum + row.costUsd!, 0) : null,
    estimated: active.some((row) => row.estimated),
    unpricedTokens: active.reduce(
      (sum, row) => sum + (row.unpricedTokens ?? (row.costUsd === null ? row.tokens : 0)),
      0,
    ),
  };
}
function Total({ row }: { row: UsageTotals | undefined }) {
  if (!row?.events) return <span className="text-muted-foreground">No data</span>;
  return (
    <span className="tabular-nums" title={row.estimated ? "Estimated at current API prices" : undefined}>
      {row.costUsd !== null
        ? `${row.estimated ? "~" : ""}${dollars(row.costUsd)}${row.unpricedTokens ? " (partial)" : ""} · `
        : ""}
      {compact(row.tokens)} tokens
      {row.costUsd === null ? <span className="ml-2 text-muted-foreground">Price unavailable</span> : null}
    </span>
  );
}

export function HistoryPanel({
  history,
  onRefresh,
  name,
  now = Date.now(),
}: {
  history: UsageHistory;
  onRefresh: () => Promise<unknown>;
  name: string;
  now?: number;
}) {
  const [range, setRange] = useState<7 | 30>(30);
  const [pending, setPending] = useState(false);
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: history.timeZone ?? "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  const today = `${part("year")}-${part("month")}-${part("day")}`;
  const offset = (days: number) => {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - days);
    return d.toISOString().slice(0, 10);
  };
  const period = history.days.filter((day) => day.date >= offset(29) && day.date <= today);
  const days = period.filter((day) => day.date >= offset(range - 1));
  const max = Math.max(1, ...days.map((day) => day.tokens));
  const total = historyTotal(period);
  const stale = history.status === "error" && history.days.length > 0;
  return (
    <section
      aria-label={`Usage history for ${name}`}
      className="min-w-0 space-y-4 rounded-lg border border-border bg-card p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">Usage trend</h2>
        <div className="flex items-center gap-1">
          <div role="group" aria-label="Trend period" className="flex gap-1">
            {([7, 30] as const).map((n) => (
              <button
                key={n}
                type="button"
                aria-pressed={range === n}
                onClick={() => setRange(n)}
                className={cn(
                  "min-h-11 rounded-md px-2 text-xs focus-visible:outline-2 focus-visible:outline-ring sm:min-h-8",
                  range === n ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {n} days
              </button>
            ))}
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="min-h-11 px-2 text-xs sm:min-h-8"
            aria-label={`Refresh history for ${name}`}
            disabled={pending || history.refreshing}
            onClick={async () => {
              setPending(true);
              try {
                await onRefresh();
              } finally {
                setPending(false);
              }
            }}
          >
            <Icon name="RefreshCw" className="size-3.5" />
            Refresh
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {history.source === "local"
          ? "Shared CLI records on this machine · Across logins · Machine time"
          : "This account’s Cursor usage export · Machine time"}
      </p>
      {days.length > 0 ? (
        <div>
          <svg
            role="img"
            aria-label={`Daily token usage over the last ${range} days${history.partial ? ", partial records" : ""}`}
            viewBox="0 0 600 88"
            className="h-24 w-full text-primary"
            preserveAspectRatio="none"
          >
            <title>{`Daily token usage over the last ${range} days. Exact values in Daily totals.`}</title>
            <line x1="0" y1="85" x2="600" y2="85" stroke="currentColor" strokeOpacity="0.2" />
            {days.map((day, i) => (
              <rect
                key={day.date}
                x={(i * 600) / days.length + 2}
                y={85 - (day.tokens / max) * 80}
                width={Math.max(1, 600 / days.length - 4)}
                height={(day.tokens / max) * 80}
                rx="2"
                fill="currentColor"
              >
                <title>{`${day.date}: ${new Intl.NumberFormat().format(day.tokens)} tokens${day.costUsd !== null ? ` · ${day.estimated ? "~" : ""}${dollars(day.costUsd)}${day.unpricedTokens ? " (partial)" : ""}` : ""}`}</title>
              </rect>
            ))}
          </svg>
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{days[0]?.date}</span>
            <span>Tokens / day</span>
            <span>{days.at(-1)?.date}</span>
          </div>
        </div>
      ) : (
        <p role="status" className="py-4 text-center text-xs text-muted-foreground">
          {history.status === "loading"
            ? "Reading usage records…"
            : history.status === "error"
              ? "Usage history could not be loaded."
              : "No usage records in the last 30 days."}
        </p>
      )}
      <dl className="space-y-2 text-xs">
        {[
          ["Today", period.find((day) => day.date === today)],
          ["Yesterday", period.find((day) => day.date === offset(1))],
          ["Last 30 days", total],
        ].map(([label, row]) => (
          <div key={label as string} className="flex flex-wrap justify-between gap-x-4 gap-y-1">
            <dt className="font-medium">{label as string}</dt>
            <dd>
              <Total row={row as UsageTotals | undefined} />
            </dd>
          </div>
        ))}
      </dl>
      {history.models.length ? (
        <details className="text-xs">
          <summary className="min-h-11 cursor-pointer py-3 font-medium sm:min-h-8">
            Models · Last 30 days
          </summary>
          <ul className="space-y-3 pt-1">
            {history.models.slice(0, 10).map((model) => (
              <li key={model.model} className="space-y-1">
                <div className="flex flex-wrap justify-between gap-2">
                  <span className="min-w-0 break-all">{model.model}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {model.costUsd !== null
                      ? `${model.estimated ? "~" : ""}${dollars(model.costUsd)}${model.unpricedTokens ? " (partial)" : ""} · `
                      : ""}
                    {compact(model.tokens)} tokens ·{" "}
                    {total.tokens ? Math.round((model.tokens / total.tokens) * 100) : 0}%
                  </span>
                </div>
                <div className="h-1 rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{
                      width: `${total.tokens ? (model.tokens / total.tokens) * 100 : 0}%`,
                    }}
                  />
                </div>
              </li>
            ))}
            {history.models.length > 10 ? (
              <li className="text-muted-foreground">
                Other models · {compact(history.models.slice(10).reduce((sum, m) => sum + m.tokens, 0))}{" "}
                tokens
              </li>
            ) : null}
          </ul>
        </details>
      ) : null}
      {days.length ? (
        <details className="text-xs">
          <summary className="min-h-11 cursor-pointer py-3 font-medium sm:min-h-8">Daily totals</summary>
          <table className="w-full text-left">
            <caption className="sr-only">Daily tokens and API cost for the last {range} days</caption>
            <thead>
              <tr className="text-muted-foreground">
                <th scope="col" className="py-2 font-normal">
                  Date
                </th>
                <th scope="col" className="py-2 text-right font-normal">
                  Usage
                </th>
              </tr>
            </thead>
            <tbody>
              {[...days].reverse().map((day) => (
                <tr key={day.date} className="border-t border-border">
                  <th scope="row" className="whitespace-nowrap py-2 pr-3 font-normal">
                    {day.date}
                  </th>
                  <td className="py-2 text-right">
                    <Total row={day} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
      {history.partial ? (
        <p role="status" className="text-xs text-foreground">
          {history.scan?.oversizedRecords
            ? `Skipped ${new Intl.NumberFormat().format(history.scan.oversizedRecords)} records over OpenUsage’s 1 MB limit. `
            : "Partial records · Some usage could not be read. "}
          {history.scan?.unreadableFiles ? `${history.scan.unreadableFiles} files could not be read. ` : ""}
          Totals may be lower than actual usage.
        </p>
      ) : null}
      {history.error ? (
        <p role="status" className="text-xs text-destructive">
          {history.error}
          {stale ? " Showing the last successful reading." : ""}
        </p>
      ) : null}
      {(history.unpricedTokens ?? total.unpricedTokens) ? (
        <p className="text-xs text-muted-foreground">
          Price unavailable for {compact(history.unpricedTokens ?? total.unpricedTokens ?? 0)} tokens. Cost
          and token totals include priced usage only.
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {history.scan && !history.refreshing && !pending && history.status !== "error"
          ? "Full history scan complete. "
          : ""}
        {history.refreshing || pending
          ? "Refreshing history…"
          : history.fetchedAt
            ? `${stale ? "Last known history" : "Updated"} ${new Date(history.fetchedAt).toLocaleTimeString()}. `
            : ""}
        ~ Estimated at current API prices, including cache rates; not subscription charges.
        {history.pricingAsOf ? ` Prices checked ${new Date(history.pricingAsOf).toLocaleDateString()}.` : ""}
      </p>
    </section>
  );
}

const LINKS = {
  antigravity: {
    status: "https://status.cloud.google.com/",
    dashboard: "https://antigravity.google/",
  },
  claude: {
    status: "https://status.claude.com/",
    dashboard: "https://claude.ai/settings/usage",
  },
  codex: {
    status: "https://status.openai.com/",
    dashboard: "https://chatgpt.com/codex/settings/usage",
  },
  cursor: {
    status: "https://status.cursor.com/",
    dashboard: "https://cursor.com/dashboard?tab=usage",
  },
  grok: { status: "https://status.x.ai/", dashboard: "https://grok.com/" },
};
export function ProviderLinks({ provider }: { provider: keyof typeof LINKS }) {
  return (
    <div className="flex gap-2">
      {(["status", "dashboard"] as const).map((key) => (
        <a
          key={key}
          href={LINKS[provider][key]}
          target="_blank"
          rel="noopener noreferrer"
          className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-md border border-border bg-card px-3 text-xs font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
        >
          {key === "status"
            ? "Status"
            : provider === "antigravity" || provider === "grok"
              ? "Manage subscription"
              : "Dashboard"}
          <Icon name="ExternalLink" className="size-3.5" />
        </a>
      ))}
    </div>
  );
}
