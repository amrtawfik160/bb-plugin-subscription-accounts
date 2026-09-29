import { aggregateHistory, emptyHistory, historyStart, type UsageEvent } from "./history.js";
import type { UsageHistory } from "./usage-types.js";
import type { ModelPricing } from "./pricing.js";

/** CSV quotes may contain commas, escaped quotes and newlines. */
export function parseCursorHistory(csv: string, now = Date.now(), pricing?: ModelPricing): UsageHistory {
  const tokenColumns = ["Input (w/ Cache Write)", "Input (w/o Cache Write)", "Cache Read", "Output Tokens"];
  let header: string[] | null = null,
    partial = false;
  const events: UsageEvent[] = [];
  // Like OpenUsage's forEachRecord: consume each row immediately, without retaining a second CSV copy.
  const consume = (row: string[]) => {
    if (!header) {
      header = row.map((v) => v.replace(/^\uFEFF/, "").trim());
      if (
        ["Date", "Model", ...tokenColumns].some((k) => !header!.includes(k)) ||
        new Set(header).size !== header.length
      )
        throw new Error("Invalid usage export");
      return;
    }
    if (row.length === 1 && !row[0].trim()) return;
    const value = (key: string) => row[header!.indexOf(key)]?.trim();
    const at = Date.parse(value("Date") ?? ""),
      model = value("Model");
    const counts = tokenColumns.map((key) => {
      const raw = value(key);
      if (raw === "") return 0;
      if (raw === undefined || !/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(raw)) return NaN;
      return Number(raw.replaceAll(",", ""));
    });
    if (
      row.length !== header.length ||
      !Number.isFinite(at) ||
      !model ||
      counts.some((n) => !Number.isSafeInteger(n) || n < 0 || n > 1e12)
    ) {
      partial = true;
      return;
    }
    events.push({
      id: null,
      at,
      model,
      tokens: counts.reduce((a, b) => a + b, 0),
      costUsd: null,
      request: false,
      tokenUsage: {
        input: counts[1],
        output: counts[3],
        cacheRead: counts[2],
        cacheWrite: counts[0],
        cacheWrite1h: 0,
      },
    });
  };
  csv = csv.replace(/^\uFEFF/, "");
  let row: string[] = [],
    fragments: string[] = [],
    start = 0,
    quoted = false,
    afterQuote = false;
  const finishCell = (end: number) => {
    if (!afterQuote) fragments.push(csv.slice(start, end));
    row.push(fragments.join(""));
    fragments = [];
    afterQuote = false;
  };
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (quoted) {
      if (ch === '"' && csv[i + 1] === '"') {
        fragments.push(csv.slice(start, i), '"');
        i++;
        start = i + 1;
      } else if (ch === '"') {
        fragments.push(csv.slice(start, i));
        quoted = false;
        afterQuote = true;
        start = i + 1;
      }
    } else if (ch === '"' && i === start && !afterQuote) {
      quoted = true;
      start = i + 1;
    } else if (ch === "," || ch === "\n" || ch === "\r") {
      finishCell(i);
      start = i + 1;
      if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && csv[i + 1] === "\n") {
          i++;
          start = i + 1;
        }
        consume(row);
        row = [];
      }
    } else if (afterQuote || ch === '"') throw new Error("Invalid usage export");
  }
  if (quoted) throw new Error("Invalid usage export");
  if (start < csv.length || row.length || fragments.length || afterQuote) {
    finishCell(csv.length);
    consume(row);
  }
  if (!header) throw new Error("Invalid usage export");
  return aggregateHistory(events, now, "cursor", partial, pricing);
}

export async function fetchCursorHistory(
  fetcher: typeof fetch,
  cookie: string,
  signal?: AbortSignal,
  pricing?: () => Promise<ModelPricing>,
): Promise<UsageHistory> {
  const now = Date.now();
  const params = new URLSearchParams({
    startDate: String(historyStart(now)),
    endDate: String(now),
    strategy: "tokens",
  });
  try {
    const timeout = AbortSignal.timeout(30_000);
    const response = await fetcher(`https://cursor.com/api/dashboard/export-usage-events-csv?${params}`, {
      headers: { Cookie: cookie, Accept: "text/csv" },
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok || !response.body) throw new Error("Unavailable");
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let csv = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        csv += decoder.decode(value, { stream: true });
      }
      csv += decoder.decode();
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    return parseCursorHistory(csv, now, await pricing?.());
  } catch {
    return {
      ...emptyHistory("cursor"),
      status: "error",
      fetchedAt: now,
      error: "Could not load Cursor’s usage export. Refresh to retry.",
    };
  }
}
