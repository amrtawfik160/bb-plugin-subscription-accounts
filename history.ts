import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { number, object, textValue, timestamp } from "./usage.js";
import { USAGE_TTL_MS, type UsageHistory, type UsageTotals } from "./usage-types.js";

export function emptyHistory(source: UsageHistory["source"] = "local"): UsageHistory {
  return {
    status: "loading",
    source,
    days: [],
    models: [],
    fetchedAt: null,
    refreshing: false,
    partial: false,
    error: null,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

export interface UsageEvent {
  id: string | null;
  at: number;
  model: string;
  tokens: number;
  costUsd: number | null;
}
const count = (v: unknown) => {
  const n = number(v);
  return n !== null && Number.isSafeInteger(n) && n >= 0 && n <= 1e12 ? n : null;
};
const cost = (v: unknown) => {
  const n = number(v);
  return n !== null && n >= 0 ? n : null;
};

export function dateKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function historyStart(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - 29);
  return d.getTime();
}

/** Local calendar days, including gaps. Missing costs stay unknown, never zero. */
export function aggregateHistory(
  events: UsageEvent[],
  now: number,
  source: UsageHistory["source"] = "local",
  partial = false,
): UsageHistory {
  const byId = new Map<string, UsageEvent>();
  const unique: UsageEvent[] = [];
  for (const event of events) {
    if (event.at < historyStart(now) || event.at > now) continue;
    if (!event.id) unique.push(event);
    else {
      const old = byId.get(event.id);
      if (!old || event.tokens > old.tokens) byId.set(event.id, event);
    }
  }
  unique.push(...byId.values());
  const days = new Map<string, UsageTotals>();
  const models = new Map<string, UsageTotals>();
  const add = (map: Map<string, UsageTotals>, key: string, e: UsageEvent) => {
    const total = map.get(key) ?? { tokens: 0, costUsd: 0, events: 0 };
    total.tokens += e.tokens;
    total.events++;
    total.costUsd = total.costUsd === null || e.costUsd === null ? null : total.costUsd + e.costUsd;
    map.set(key, total);
  };
  for (const event of unique) {
    add(days, dateKey(event.at), event);
    add(models, event.model, event);
  }
  const daily: UsageHistory["days"] = [];
  const d = new Date(historyStart(now));
  for (let i = 0; i < 30; i++, d.setDate(d.getDate() + 1)) {
    const date = dateKey(d.getTime());
    daily.push({ date, ...(days.get(date) ?? { tokens: 0, costUsd: null, events: 0 }) });
  }
  return {
    ...emptyHistory(source),
    status: unique.length ? "ready" : "unavailable",
    fetchedAt: now,
    partial,
    days: unique.length ? daily : [],
    models: [...models].map(([model, t]) => ({ model, ...t })).sort((a, b) => b.tokens - a.tokens),
  };
}

/** Parse usage fields only. Conversation text never enters the cache or RPC. */
export function createLogParser(provider: "claude" | "codex" | "grok") {
  let model = "Unknown model";
  let previous: number[] | null = null;
  let sawMeta = false;
  let childCreated: number | null = null;
  let childReplay = false;
  return (raw: unknown): UsageEvent[] => {
    const row = object(raw);
    const at = timestamp(row.timestamp);
    if (provider === "claude") {
      const message = object(row.message),
        u = object(message.usage);
      const input = count(u.input_tokens),
        output = count(u.output_tokens);
      if (!at || input === null || output === null || row.isApiErrorMessage === true) return [];
      const id = textValue(message.id);
      const tokens =
        input +
        output +
        (count(u.cache_read_input_tokens) ?? 0) +
        (count(u.cache_creation_input_tokens) ?? 0);
      return [
        {
          id: id ? `claude:${id}` : null,
          at,
          model: textValue(message.model) ?? "Unknown model",
          tokens,
          costUsd: cost(row.costUSD),
        },
      ];
    }
    if (provider === "grok") {
      const params = object(row.params),
        update = object(params.update ?? row.update),
        usage = object(update.usage);
      if (update.sessionUpdate !== "turn_completed") return [];
      const meta = object(params._meta ?? row._meta);
      const time = number(meta.agentTimestampMs) ?? at;
      if (!time) return [];
      const entries = Object.entries(object(usage.modelUsage));
      return entries.flatMap(([model, value]) => {
        const u = object(value),
          input = count(u.inputTokens),
          output = count(u.outputTokens) ?? 0;
        if (input === null) return [];
        const ticks = cost(u.costUsdTicks) ?? (entries.length === 1 ? cost(usage.costUsdTicks) : null);
        const id = textValue(meta.eventId);
        return [
          {
            id: id ? `grok:${id}:${model}` : null,
            at: time,
            model,
            tokens: input + output,
            costUsd: ticks === null ? null : ticks / 1e10,
          },
        ];
      });
    }
    const payload = object(row.payload);
    if (row.type === "session_meta" && !sawMeta) {
      sawMeta = true;
      const source = object(payload.source);
      childReplay =
        source.subagent != null ||
        textValue(payload.forked_from_id) !== null ||
        textValue(payload.parent_thread_id) !== null ||
        payload.thread_source === "subagent";
      childCreated = at;
      return [];
    }
    if (row.type === "turn_context") {
      model = textValue(payload.model) ?? model;
      return [];
    }
    if (row.type !== "event_msg") return [];
    if (payload.type === "task_started" && childReplay) {
      const started = timestamp(payload.started_at);
      if (started !== null && started >= Math.floor((childCreated ?? at ?? Infinity) / 1000) * 1000)
        childReplay = false;
      return [];
    }
    if (payload.type !== "token_count" || !at) return [];
    const info = object(payload.info);
    const fields = (v: unknown) => {
      const u = object(v);
      return [count(u.input_tokens) ?? 0, count(u.output_tokens) ?? 0, count(u.total_tokens) ?? 0];
    };
    const total = info.total_token_usage ? fields(info.total_token_usage) : null;
    if (childReplay) {
      previous = total ?? previous;
      return [];
    }
    if (total && previous && total.every((n, i) => n === previous![i])) return [];
    const delta = info.last_token_usage
      ? fields(info.last_token_usage)
      : total?.map((n, i) => Math.max(0, n - (previous?.[i] ?? 0)));
    previous = total ?? previous;
    if (!delta) return [];
    const tokens = delta[2] || delta[0] + delta[1];
    if (!tokens) return [];
    model = textValue(payload.model ?? info.model) ?? model;
    return [{ id: `codex:${at}:${model}:${delta.join(":")}`, at, model, tokens, costUsd: null }];
  };
}

type LocalProvider = "claude" | "codex" | "grok";
export class HistoryCache {
  private views = new Map<LocalProvider, UsageHistory>();
  private pending = new Map<LocalProvider, Promise<void>>();
  private attempted = new Map<LocalProvider, number>();
  private files = new Map<string, { size: number; mtime: number; events: UsageEvent[]; partial: boolean }>();
  private disposed = false;
  constructor(
    private changed: () => void,
    private home = os.homedir(),
    private env = process.env,
    private now = Date.now,
  ) {}
  get(provider: LocalProvider) {
    return this.views.get(provider) ?? emptyHistory();
  }
  dispose() {
    this.disposed = true;
    this.files.clear();
  }
  refresh(provider: LocalProvider, force = false): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const pending = this.pending.get(provider);
    if (pending) return pending;
    const old = this.get(provider);
    const attempted = this.attempted.get(provider);
    if (!force && attempted !== undefined && this.now() - attempted < USAGE_TTL_MS) return Promise.resolve();
    this.attempted.set(provider, this.now());
    this.views.set(provider, { ...old, refreshing: true });
    const task = this.scan(provider)
      .then((next) => {
        if (!this.disposed) this.views.set(provider, next);
      })
      .catch(() => {
        if (!this.disposed)
          this.views.set(provider, {
            ...old,
            status: "error",
            refreshing: false,
            error: "Could not read local usage records. Refresh to retry.",
          });
      })
      .finally(() => {
        this.pending.delete(provider);
        if (!this.disposed) this.changed();
      });
    this.pending.set(provider, task);
    return task;
  }
  private async scan(provider: LocalProvider): Promise<UsageHistory> {
    const resolve = (value: string | undefined, fallback: string) =>
      value ? path.resolve(value.replace(/^~(?=\/|$)/, this.home)) : path.join(this.home, fallback);
    const configured =
      provider === "claude"
        ? this.env.CLAUDE_CONFIG_DIR
        : provider === "codex"
          ? this.env.CODEX_HOME
          : this.env.GROK_HOME;
    const homes = configured?.trim()
      ? configured.split(",").map((v) => resolve(v.trim(), `.${provider}`))
      : provider === "claude"
        ? [path.join(resolve(this.env.XDG_CONFIG_HOME, ".config"), "claude"), path.join(this.home, ".claude")]
        : [path.join(this.home, `.${provider}`)];
    const roots = [
      ...new Set(
        homes.flatMap((home) =>
          provider === "codex"
            ? [path.join(home, "sessions"), path.join(home, "archived_sessions")]
            : [
                provider === "claude" && path.basename(home) === "projects"
                  ? home
                  : path.join(home, provider === "claude" ? "projects" : "sessions"),
              ],
        ),
      ),
    ];
    const files: string[] = [];
    let partial = false,
      visited = 0;
    const walk = async (dir: string, depth = 0): Promise<void> => {
      if (this.disposed || depth > 12 || visited > 20_000) {
        partial = true;
        return;
      }
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (e) {
        if (object(e).code !== "ENOENT") partial = true;
        return;
      }
      for (const entry of entries.sort((a, b) => b.name.localeCompare(a.name))) {
        if (++visited > 20_000 || this.disposed) {
          partial = true;
          break;
        }
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(file, depth + 1);
        else if (
          entry.isFile() &&
          entry.name.endsWith(".jsonl") &&
          (provider !== "grok" || entry.name === "updates.jsonl")
        )
          files.push(file);
      }
    };
    for (const root of roots) await walk(root);
    const all: UsageEvent[] = [];
    let bytes = 0;
    const seen = new Set<string>();
    const recentFiles = await Promise.all(
      files.map(async (file) => ({ file, stat: await fs.stat(file).catch(() => null) })),
    );
    recentFiles.sort((a, b) => (b.stat?.mtimeMs ?? 0) - (a.stat?.mtimeMs ?? 0));
    for (const { file, stat } of recentFiles) {
      if (this.disposed) break;
      if (!stat) {
        partial = true;
        continue;
      }
      if (stat.mtimeMs < historyStart(this.now())) continue;
      seen.add(file);
      const cached = this.files.get(file);
      if (cached?.size === stat.size && cached.mtime === stat.mtimeMs) {
        for (const event of cached.events) all.push(event);
        partial ||= cached.partial;
        continue;
      }
      if (stat.size > 64 * 1024 * 1024 || bytes + stat.size > 256 * 1024 * 1024) {
        partial = true;
        continue;
      }
      bytes += stat.size;
      const parser = createLogParser(provider),
        events: UsageEvent[] = [];
      let filePartial = false;
      const stream = createReadStream(file);
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          if (this.disposed) break;
          if (events.length >= 100_000) {
            filePartial = true;
            break;
          }
          if (line.length > 2 * 1024 * 1024) {
            filePartial = true;
            continue;
          }
          if (!/usage|token_count|turn_context|session_meta|task_started/.test(line)) continue;
          try {
            events.push(...parser(JSON.parse(line)).filter((e) => e.at >= historyStart(this.now())));
          } catch {
            filePartial = true;
          }
        }
      } finally {
        lines.close();
        stream.destroy();
      }
      if (!this.disposed)
        this.files.set(file, { size: stat.size, mtime: stat.mtimeMs, events, partial: filePartial });
      for (const event of events) all.push(event);
      partial ||= filePartial;
    }
    for (const file of this.files.keys())
      if (roots.some((root) => file.startsWith(root + path.sep)) && !seen.has(file)) this.files.delete(file);
    return aggregateHistory(all, this.now(), "local", partial);
  }
}
