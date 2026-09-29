import { aggregateHistory, emptyHistory, historyStart, type UsageEvent } from "./history.js";
import type { UsageHistory } from "./usage-types.js";
import type { ModelPricing } from "./pricing.js";

/** CSV quotes may contain commas, escaped quotes and newlines. */
export function parseCursorHistory(csv: string, now = Date.now(), pricing?: ModelPricing): UsageHistory {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false,
    afterQuote = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (quoted) {
      if (ch === '"' && csv[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
        afterQuote = true;
      } else cell += ch;
    } else if (ch === '"' && !cell && !afterQuote) quoted = true;
    else if (ch === "," || ch === "\n") {
      row.push(cell.replace(/\r$/, ""));
      cell = "";
      afterQuote = false;
      if (ch === "\n") {
        rows.push(row);
        row = [];
      }
    } else if (afterQuote && ch !== "\r") throw new Error("Invalid usage export");
    else cell += ch;
  }
  if (quoted) throw new Error("Invalid usage export");
  if (cell || row.length) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }
  const header = rows.shift()?.map((v) => v.replace(/^\uFEFF/, "").trim()) ?? [];
  const tokenColumns = ["Input (w/ Cache Write)", "Input (w/o Cache Write)", "Cache Read", "Output Tokens"];
  if (
    ["Date", "Model", ...tokenColumns].some((k) => !header.includes(k)) ||
    new Set(header).size !== header.length
  )
    throw new Error("Invalid usage export");
  const events: UsageEvent[] = [];
  let partial = false;
  for (const row of rows) {
    if (row.length === 1 && !row[0].trim()) continue;
    const value = (key: string) => row[header.indexOf(key)]?.trim();
    const at = Date.parse(value("Date") ?? "");
    const model = value("Model");
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
      continue;
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
  }
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
    const timeout = AbortSignal.timeout(15_000);
    const response = await fetcher(`https://cursor.com/api/dashboard/export-usage-events-csv?${params}`, {
      headers: { Cookie: cookie, Accept: "text/csv" },
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok || !response.body) throw new Error("Unavailable");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let csv = "",
      bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 16 * 1024 * 1024) throw new Error("Export too large");
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
