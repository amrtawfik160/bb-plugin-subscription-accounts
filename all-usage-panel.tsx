import { useState, type ReactNode } from "react";
import { aggregateProviders, sumUsage, type UsagePeriod, type UsageProvider } from "./all-usage";
import type { Overview } from "./app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const compact = (n: number) =>
  new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
const dollars = (n: number) =>
  new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(n);
const PERIODS: { id: UsagePeriod; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "30days", label: "30 Days" },
];

export function AllUsage({
  data,
  onRefresh,
  onOpenProvider,
  children,
}: {
  data: Overview;
  onRefresh: () => Promise<unknown>;
  onOpenProvider: (provider: UsageProvider) => void;
  children: ReactNode;
}) {
  const [period, setPeriod] = useState<UsagePeriod>("30days");
  const [metric, setMetric] = useState<"cost" | "tokens">("cost");
  const [pending, setPending] = useState(false);
  const value = (row: ReturnType<typeof sumUsage>) => (metric === "cost" ? (row.costUsd ?? 0) : row.tokens);
  const providers = aggregateProviders(data, period, data.now).sort(
    (a, b) => Number(b.available) - Number(a.available) || value(b.total) - value(a.total),
  );
  const available = providers.filter((provider) => provider.available);
  const total = sumUsage(available.map((provider) => provider.total));
  const costAmount = (row: typeof total) =>
    row.costUsd === null ? "Price unavailable" : `${row.estimated ? "~" : ""}${dollars(row.costUsd)}`;
  const amount = (row: typeof total) =>
    metric === "cost" ? costAmount(row) : `${compact(row.tokens)} tokens`;
  const chartTotal = available.reduce((sum, provider) => sum + value(provider.total), 0);
  const incomplete =
    providers.some((provider) => !provider.available || provider.partial || provider.stale) ||
    !!total.unpricedTokens;
  const loading = providers.some((provider) => provider.loading);
  const excludedUnpricedTokens = providers.reduce(
    (sum, provider) => sum + provider.excludedUnpricedTokens,
    0,
  );
  const centerAmount =
    metric === "tokens"
      ? compact(chartTotal)
      : total.costUsd === null
        ? "—"
        : `${total.estimated ? "~" : ""}${chartTotal < 1000 ? dollars(chartTotal) : `$${compact(chartTotal)}`}`;
  let offset = 0;
  const slices = providers
    .filter((provider) => provider.available && value(provider.total) > 0)
    .map((provider) => {
      const fraction = value(provider.total) / chartTotal;
      const slice = { ...provider, fraction, offset };
      offset += fraction;
      return slice;
    });
  const days = [...new Set(available.flatMap((provider) => provider.days.map((day) => day.date)))]
    .sort()
    .map((date) => ({
      date,
      ...sumUsage(available.flatMap((provider) => provider.days.filter((day) => day.date === date))),
    }));
  const maxDay = Math.max(1, ...days.map(value));
  const oldest = available.map((provider) => provider.fetchedAt).filter((at): at is number => at !== null);
  return (
    <div className="space-y-5">
      <section
        aria-label="All subscription usage"
        className="min-w-0 space-y-4 rounded-lg border border-border bg-card p-4 sm:p-5"
      >
        <div className="flex items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <span className="sr-only">Usage metric</span>
            <select
              aria-label="Usage metric"
              value={metric}
              onChange={(event) => setMetric(event.target.value as "cost" | "tokens")}
              className="min-h-11 rounded-md border border-border bg-card px-2 text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              <option value="cost">Cost</option>
              <option value="tokens">Tokens</option>
            </select>
          </label>
          <Button
            size="sm"
            variant="ghost"
            className="min-h-11"
            disabled={pending || providers.some((provider) => provider.refreshing)}
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
            {pending ? "Refreshing…" : "Refresh all"}
          </Button>
        </div>
        <div role="group" aria-label="Usage period" className="flex rounded-full bg-muted p-1">
          {PERIODS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              aria-pressed={period === id}
              onClick={() => setPeriod(id)}
              className={cn(
                "min-h-11 min-w-0 flex-1 rounded-full px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring",
                period === id
                  ? "bg-card font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex flex-col items-center gap-5 py-2 sm:flex-row sm:gap-8">
          <div className="w-52 shrink-0 text-center">
            <div className="relative size-52">
              <svg
                role="img"
                aria-label={`${metric === "cost" ? "Cost" : "Token"} share by provider for ${PERIODS.find((p) => p.id === period)!.label}`}
                viewBox="0 0 200 200"
                className="size-full"
              >
                <title>
                  {chartTotal > 0
                    ? slices
                        .map(
                          (slice) =>
                            `${slice.label}: ${amount(slice.total)} (${(slice.fraction * 100).toFixed(1)}%)`,
                        )
                        .join("; ")
                    : loading
                      ? "Reading usage history"
                      : "No chartable usage in this period"}
                </title>
                <circle cx="100" cy="100" r="80" fill="none" stroke="var(--muted)" strokeWidth="28" />
                {slices.map((slice) => {
                  const gap = slices.length > 1 ? Math.min(0.8, (slice.fraction * 100) / 3) : 0;
                  const length = slice.fraction * 100 - gap;
                  return (
                    <circle
                      key={slice.id}
                      cx="100"
                      cy="100"
                      r="80"
                      pathLength="100"
                      fill="none"
                      stroke={slice.color}
                      strokeWidth="28"
                      strokeDasharray={`${length} ${100 - length}`}
                      strokeDashoffset={-(slice.offset * 100 + gap / 2)}
                      transform="rotate(-90 100 100)"
                    >
                      <title>{`${slice.label}: ${amount(slice.total)} · ${(slice.fraction * 100).toFixed(1)}%`}</title>
                    </circle>
                  );
                })}
              </svg>
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
                <span
                  className="max-w-[60%] text-2xl font-semibold tabular-nums"
                  data-testid="all-usage-total"
                >
                  {available.length ? centerAmount : "—"}
                </span>
                <span className="mt-1 text-xs text-muted-foreground">
                  {available.length
                    ? metric === "cost"
                      ? "dollars"
                      : "tokens"
                    : loading
                      ? "Loading history…"
                      : "History unavailable"}
                </span>
              </div>
            </div>
            {incomplete && available.length ? (
              <p className="mt-2 text-xs text-muted-foreground">Available history</p>
            ) : null}
          </div>
          <ul aria-label="Usage by provider" className="w-full min-w-0 flex-1 space-y-1">
            {providers.map((provider) => (
              <li key={provider.id}>
                <button
                  type="button"
                  onClick={() => onOpenProvider(provider.id)}
                  className="flex min-h-11 w-full items-start gap-3 rounded-md px-2 py-2 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <span
                    className="mt-1.5 size-3 shrink-0 rounded-full"
                    style={{ background: provider.color }}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 text-sm font-medium">
                    {provider.label}
                    <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                      {provider.available
                        ? `${compact(provider.total.tokens)} tokens · ${compact(provider.total.events)} events${provider.stale ? " · Last known" : provider.partial || provider.total.unpricedTokens ? " · Partial" : ""}`
                        : provider.loading
                          ? "Reading history…"
                          : provider.id === "antigravity"
                            ? "Quota API has no history"
                            : "History unavailable · Open to retry"}
                    </span>
                  </span>
                  <span className="shrink-0 text-right text-sm tabular-nums">
                    <span className="block">{provider.available ? amount(provider.total) : "—"}</span>
                    {provider.available &&
                    chartTotal > 0 &&
                    (metric === "tokens" || provider.total.costUsd !== null) ? (
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {((value(provider.total) / chartTotal) * 100).toFixed(1)}%
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        {available.length ? (
          <p className="text-xs text-muted-foreground">
            {costAmount(total)} · {compact(total.tokens)} tokens · {compact(total.events)} events
            {total.unpricedTokens ? ` · ${compact(total.unpricedTokens)} tokens without prices` : ""}
          </p>
        ) : (
          <p role="status" className="text-xs text-muted-foreground">
            {loading
              ? "Reading usage history across providers…"
              : "No history could be loaded. Refresh all or open a provider to check its connection."}
          </p>
        )}
        {days.length > 1 ? (
          <div>
            <svg
              role="img"
              aria-label={`Combined daily ${metric === "cost" ? "cost" : "token usage"}`}
              viewBox="0 0 600 72"
              preserveAspectRatio="none"
              className="h-20 w-full text-foreground"
            >
              <title>Daily totals from available provider history</title>
              {days.map((day, i) => (
                <rect
                  key={day.date}
                  x={(i * 600) / days.length + 2}
                  y={70 - (value(day) / maxDay) * 65}
                  width={Math.max(1, 600 / days.length - 4)}
                  height={(value(day) / maxDay) * 65}
                  rx="2"
                  fill="currentColor"
                >
                  <title>{`${day.date}: ${amount(day)} · ${compact(day.tokens)} tokens`}</title>
                </rect>
              ))}
            </svg>
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{days[0].date}</span>
              <span>{metric === "cost" ? "Cost" : "Tokens"} / day</span>
              <span>{days.at(-1)!.date}</span>
            </div>
          </div>
        ) : null}
        {days.length ? (
          <details className="text-xs">
            <summary className="min-h-11 cursor-pointer py-3 font-medium focus-visible:outline-2 focus-visible:outline-ring">
              Daily totals
            </summary>
            <div className="overflow-x-auto">
              <table className="w-full text-left tabular-nums">
                <caption className="sr-only">
                  Combined daily totals from available subscription history
                </caption>
                <thead>
                  <tr className="text-muted-foreground">
                    <th scope="col" className="py-2 pr-3 font-medium">
                      Date
                    </th>
                    <th scope="col" className="py-2 pr-3 text-right font-medium">
                      Cost
                    </th>
                    <th scope="col" className="py-2 text-right font-medium">
                      Tokens
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[...days].reverse().map((day) => (
                    <tr key={day.date} className="border-t border-border">
                      <th scope="row" className="whitespace-nowrap py-2 pr-3 font-normal">
                        {day.date}
                      </th>
                      <td className="whitespace-nowrap py-2 pr-3 text-right">
                        {day.costUsd === null
                          ? "Price unavailable"
                          : `${day.estimated ? "~" : ""}${dollars(day.costUsd)}${day.unpricedTokens ? " (partial)" : ""}`}
                      </td>
                      <td className="py-2 text-right">{new Intl.NumberFormat().format(day.tokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        ) : null}
        <div className="space-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
          <p>
            Claude, Codex and Grok: shared CLI history across logins on this machine. Cursor: saved account
            exports. Dates use each source’s machine time.
          </p>
          {total.estimated ? (
            <p>~ Estimated at API prices; these amounts are not your subscription bill.</p>
          ) : null}
          {excludedUnpricedTokens > 0 ? (
            <p>
              In the 30-day scan, {compact(excludedUnpricedTokens)} tokens had no API price and were excluded
              from usage totals.
            </p>
          ) : null}
          {incomplete ? (
            <p>
              Totals include available history only. Unavailable sources, skipped records and tokens without
              prices are excluded from the cost chart.
            </p>
          ) : null}
          {oldest.length ? (
            <p title={new Date(Math.min(...oldest)).toLocaleString()}>
              History updated · {new Date(Math.min(...oldest)).toLocaleString()}
            </p>
          ) : null}
        </div>
      </section>
      {children}
    </div>
  );
}
