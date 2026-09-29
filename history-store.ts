import type Database from "better-sqlite3";
import { z } from "zod";
import type { UsageEvent } from "./history.js";
import type { LocalProvider } from "./history-discovery.js";

export interface CachedUsageFile {
  size: number;
  mtime: number;
  events: UsageEvent[];
  partial: boolean;
  oversizedRecords?: number;
}
export interface HistoryFileStore {
  get(
    provider: LocalProvider,
    identity: string,
    file: string,
    size: number,
    mtime: number,
  ): CachedUsageFile | undefined;
  put(provider: LocalProvider, identity: string, file: string, value: CachedUsageFile): void;
  prune(provider: LocalProvider, identity: string, files: Set<string>, since: number): void;
}
const nonnegative = z.number().finite().nonnegative();
const eventSchema = z.object({
  id: z.string().nullable(),
  at: z.number().finite(),
  model: z.string(),
  tokens: nonnegative,
  costUsd: nonnegative.nullable(),
  pricingModel: z.string().optional(),
  request: z.boolean().optional(),
  tokenUsage: z
    .object({
      input: nonnegative,
      output: nonnegative,
      cacheRead: nonnegative,
      cacheWrite: nonnegative,
      cacheWrite1h: nonnegative,
      fast: z.boolean().optional(),
    })
    .optional(),
  claude: z
    .object({
      messageId: z.string(),
      requestId: z.string().nullable(),
      sidechain: z.boolean(),
      hasSpeed: z.boolean(),
    })
    .optional(),
});
const cachedSchema = z.object({
  events: z.array(eventSchema),
  partial: z.boolean(),
  oversizedRecords: nonnegative.optional(),
});
const PARSER_VERSION = 1;

/** Per-source normalized events, keyed by source configuration + path + size + mtime. */
export function sqliteHistoryStore(db: Database.Database): HistoryFileStore {
  const get = db.prepare(
    "SELECT body FROM usage_log_cache WHERE provider=? AND identity=? AND path=? AND size=? AND mtime=? AND schema_version=?",
  );
  const put = db.prepare(
    "INSERT OR REPLACE INTO usage_log_cache (provider,identity,path,size,mtime,schema_version,body,updated_at) VALUES (?,?,?,?,?,?,?,?)",
  );
  const paths = db.prepare("SELECT path,mtime FROM usage_log_cache WHERE provider=? AND identity=?");
  const remove = db.prepare("DELETE FROM usage_log_cache WHERE provider=? AND identity=? AND path=?");
  return {
    get(provider, identity, file, size, mtime) {
      try {
        const row = get.get(provider, identity, file, size, mtime, PARSER_VERSION) as
          { body: string } | undefined;
        if (!row) return;
        const value = cachedSchema.parse(JSON.parse(row.body));
        return { size, mtime, ...value };
      } catch {
        return undefined;
      }
    },
    put(provider, identity, file, value) {
      put.run(
        provider,
        identity,
        file,
        value.size,
        value.mtime,
        PARSER_VERSION,
        JSON.stringify({
          events: value.events,
          partial: value.partial,
          oversizedRecords: value.oversizedRecords,
        }),
        Date.now(),
      );
    },
    prune(provider, identity, files, since) {
      db.transaction(() => {
        for (const row of paths.all(provider, identity) as { path: string; mtime: number }[])
          if (!files.has(row.path) || row.mtime < since) remove.run(provider, identity, row.path);
        db.prepare("DELETE FROM usage_log_cache WHERE updated_at < ?").run(Date.now() - 35 * 86400000);
      })();
    },
  };
}
