import fs from "node:fs/promises";
import os from "node:os";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { number, object, textValue, timestamp } from "./usage.js";
import { USAGE_TTL_MS, type UsageHistory, type UsageTotals } from "./usage-types.js";
import type { ModelPricing, TokenUsage } from "./pricing.js";
import { readJSONL } from "./jsonl-scanner.js";
import { discoverHistory, type LocalProvider } from "./history-discovery.js";
import type { CachedUsageFile, HistoryFileStore } from "./history-store.js";

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
  tokenUsage?: TokenUsage;
  request?: boolean;
  pricingModel?: string;
  claude?: { messageId: string; requestId: string | null; sidechain: boolean; hasSpeed: boolean };
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

/** Local calendar days, including gaps. Reported costs take precedence over API estimates. */
export function aggregateHistory(
  events: UsageEvent[],
  now: number,
  source: UsageHistory["source"] = "local",
  partial = false,
  pricing?: ModelPricing,
): UsageHistory {
  const unique = dedupHistory(events).filter((event) => event.at >= historyStart(now) && event.at <= now);
  const unpricedModels = new Set<string>();
  let unpricedTokens = 0;
  const days = new Map<string, UsageTotals>();
  const models = new Map<string, UsageTotals>();
  const add = (
    map: Map<string, UsageTotals>,
    key: string,
    e: UsageEvent,
    amount: number | null,
    estimated: boolean,
  ) => {
    const total = map.get(key) ?? { tokens: 0, costUsd: null, events: 0 };
    total.tokens += e.tokens;
    total.events++;
    if (amount !== null) total.costUsd = (total.costUsd ?? 0) + amount;
    else if (e.tokens) total.unpricedTokens = (total.unpricedTokens ?? 0) + e.tokens;
    if (estimated) total.estimated = true;
    map.set(key, total);
  };
  for (const event of unique) {
    const estimate =
      event.costUsd === null && event.tokenUsage
        ? (pricing?.estimate(event.pricingModel ?? event.model, event.tokenUsage, event.request) ?? null)
        : null;
    const amount = event.costUsd ?? estimate;
    // OpenUsage excludes unpriceable events from both spend and token totals, with a separate warning.
    if (pricing && amount === null) {
      if (event.tokens > 0) {
        unpricedTokens += event.tokens;
        unpricedModels.add(event.model);
      }
      continue;
    }
    add(days, dateKey(event.at), event, amount, estimate !== null);
    add(models, event.model, event, amount, estimate !== null);
  }
  const daily: UsageHistory["days"] = [];
  const d = new Date(historyStart(now));
  for (let i = 0; i < 30; i++, d.setDate(d.getDate() + 1)) {
    const date = dateKey(d.getTime());
    daily.push({
      date,
      ...(days.get(date) ?? { tokens: 0, costUsd: null, events: 0 }),
    });
  }
  return {
    ...emptyHistory(source),
    status: unique.length ? "ready" : "unavailable",
    fetchedAt: now,
    partial,
    ...(pricing ? { pricingAsOf: pricing.data.checkedAt } : {}),
    ...(unpricedTokens ? { unpricedTokens, unpricedModels: [...unpricedModels].sort() } : {}),
    days: unique.length ? daily : [],
    models: [...models].map(([model, t]) => ({ model, ...t })).sort((a, b) => b.tokens - a.tokens),
  };
}

/** OpenUsage's provider-specific replay and streaming deduplication rules. */
export function dedupHistory(events: UsageEvent[]): UsageEvent[] {
  const result: UsageEvent[] = [],
    exact = new Map<string, number>(),
    messages = new Map<string, number[]>();
  for (const event of events) {
    const c = event.claude;
    const key = c ? JSON.stringify([c.messageId, c.requestId]) : event.id;
    const collision = key
      ? (exact.get(key) ??
        (c ? messages.get(c.messageId)?.find((i) => c.sidechain || result[i].claude?.sidechain) : undefined))
      : undefined;
    if (collision !== undefined) {
      const old = result[collision];
      if (c && old.claude) {
        const replace =
          c.sidechain !== old.claude.sidechain
            ? old.claude.sidechain
            : event.tokens !== old.tokens
              ? event.tokens > old.tokens
              : c.hasSpeed && !old.claude.hasSpeed;
        if (replace) {
          exact.delete(JSON.stringify([old.claude.messageId, old.claude.requestId]));
          result[collision] = event;
          exact.set(key!, collision);
        }
      }
      continue;
    }
    const index = result.length;
    result.push(event);
    if (key) exact.set(key, index);
    if (c) messages.set(c.messageId, [...(messages.get(c.messageId) ?? []), index]);
  }
  return result;
}

/** Parse usage fields only. Conversation text never enters the cache or RPC. */
export function createLogParser(provider: LocalProvider) {
  let model: string | null = null,
    previous: number[] | null = null;
  let sawMeta = false,
    childCreated: number | null = null,
    childReplay = false,
    fast = false;
  const modelName = (o: Record<string, unknown>) =>
    textValue(o.model) ?? textValue(o.model_name) ?? textValue(object(o.metadata).model);
  const hasValue = (v: unknown) => v != null && (typeof v !== "string" || v.trim() !== "");
  const tokenBreakdown = (u: Record<string, unknown>): TokenUsage | null => {
    const input = count(u.input_tokens),
      output = count(u.output_tokens);
    if (
      input === null ||
      output === null ||
      (typeof u.speed === "string" && u.speed !== "fast" && u.speed !== "standard")
    )
      return null;
    const creation = object(u.cache_creation),
      hasCreation = u.cache_creation !== undefined && u.cache_creation !== null;
    return {
      input,
      output,
      cacheRead: count(u.cache_read_input_tokens) ?? 0,
      cacheWrite: hasCreation
        ? (count(creation.ephemeral_5m_input_tokens) ?? 0)
        : (count(u.cache_creation_input_tokens) ?? 0),
      cacheWrite1h: hasCreation ? (count(creation.ephemeral_1h_input_tokens) ?? 0) : 0,
      fast: u.speed === "fast",
    };
  };
  return (raw: unknown): UsageEvent[] => {
    const row = object(raw),
      at = timestamp(row.timestamp);
    if (provider === "claude") {
      const message = object(row.message),
        u = object(message.usage);
      if (!at) return [];
      const levels: [Record<string, unknown>, string[]][] = [
        [row, ["cwd", "costUSD", "version", "sessionId", "requestId", "isApiErrorMessage"]],
        [message, ["id", "model"]],
        [u, ["speed", "cache_read_input_tokens", "cache_creation_input_tokens"]],
      ];
      if (levels.some(([o, keys]) => keys.some((k) => o[k] === null))) return [];
      if (typeof row.version === "string" && !/^\d+\.\d+\.\d/.test(row.version)) return [];
      if ([row.sessionId, row.requestId, message.id, message.model].some((v) => v === "")) return [];
      const usage = tokenBreakdown(u);
      if (!usage) return [];
      const messageId = textValue(message.id),
        requestId = textValue(row.requestId);
      const make = (
        tokens: TokenUsage,
        id: string | null,
        model: string | null,
        carried: number | null,
        hasSpeed: boolean,
      ): UsageEvent => ({
        id: id ? `claude:${id}` : null,
        at,
        model: model === "<synthetic>" ? "Unknown model" : (model ?? "Unknown model"),
        tokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite + tokens.cacheWrite1h,
        costUsd: carried,
        tokenUsage: tokens,
        ...(id
          ? { claude: { messageId: id, requestId, sidechain: row.isSidechain === true, hasSpeed } }
          : {}),
      });
      const entries = [
        make(usage, messageId, textValue(message.model), cost(row.costUSD), typeof u.speed === "string"),
      ];
      let advisor = 0;
      for (const raw of Array.isArray(u.iterations) ? u.iterations : []) {
        const iteration = object(raw),
          tokens = tokenBreakdown(iteration),
          advisorModel = textValue(iteration.model);
        if (iteration.type !== "advisor_message" || !tokens || !advisorModel) continue;
        entries.push(
          make(
            tokens,
            messageId ? `${messageId}:advisor:${advisor}` : null,
            advisorModel,
            null,
            typeof iteration.speed === "string",
          ),
        );
        advisor++;
      }
      return entries;
    }
    if (provider === "grok") {
      const params = object(row.params),
        update = object(params.update ?? row.update),
        usage = object(update.usage);
      if (update.sessionUpdate !== "turn_completed") return [];
      const time =
        [number(object(params._meta).agentTimestampMs), number(object(row._meta).agentTimestampMs)].find(
          (n) => n !== null && n > 0,
        ) ?? at;
      if (!time || time <= 0) return [];
      const entries = Object.entries(object(usage.modelUsage)).sort(([a], [b]) => a.localeCompare(b));
      const bounded = (v: unknown) => Math.min(1e12, Math.max(0, Math.trunc(number(v) ?? 0)));
      return entries.flatMap(([rawModel, value]) => {
        const u = object(value),
          inputValue = number(u.inputTokens),
          model = rawModel.trim();
        if (!model || inputValue === null || inputValue < 0) return [];
        const input = bounded(inputValue),
          output = bounded(u.outputTokens),
          cacheRead = Math.min(input, bounded(u.cachedReadTokens)),
          cacheWrite = Math.min(input - cacheRead, bounded(u.cacheCreationTokens));
        const ticks = cost(u.costUsdTicks) ?? (entries.length === 1 ? cost(usage.costUsdTicks) : null);
        const id = textValue(object(params._meta ?? row._meta).eventId);
        return [
          {
            id: id ? `grok:${id}:${model}` : null,
            at: time,
            model,
            tokens: input + output,
            costUsd: ticks === null ? null : ticks / 1e10,
            tokenUsage: {
              input: input - cacheRead - cacheWrite,
              output,
              cacheRead,
              cacheWrite,
              cacheWrite1h: 0,
            },
          },
        ];
      });
    }
    const payload = object(row.payload);
    if (row.type === "session_meta" && !sawMeta) {
      sawMeta = true;
      childReplay =
        hasValue(object(payload.source).subagent) ||
        hasValue(payload.forked_from_id) ||
        hasValue(payload.parent_thread_id) ||
        payload.thread_source === "subagent";
      childCreated = at;
      return [];
    }
    if (row.type === "turn_context") {
      model = modelName(payload) ?? model;
      return [];
    }
    if (row.type !== "event_msg") return [];
    if (payload.type === "thread_settings_applied") {
      const tier = textValue(object(payload.thread_settings).service_tier) ?? textValue(payload.service_tier);
      if (tier) fast = tier === "fast" || tier === "priority";
      return [];
    }
    if (payload.type === "task_started" && childReplay) {
      const started = number(payload.started_at),
        gate = childCreated ?? at;
      if (started !== null && gate !== null && started >= Math.floor(gate / 1000)) childReplay = false;
      return [];
    }
    if (payload.type !== "token_count" || !at) return [];
    const info = object(payload.info);
    const fields = (raw: unknown) => {
      const u = object(raw),
        n = (...keys: string[]) => keys.map((k) => count(u[k])).find((v) => v !== null) ?? 0;
      const input = n("input_tokens", "prompt_tokens", "input"),
        output = n("output_tokens", "completion_tokens", "output"),
        reasoning = n("reasoning_output_tokens", "reasoning_tokens");
      const reported = n("total_tokens");
      return [
        input,
        output,
        reported > 0 ? reported : input + output + reasoning,
        n("cached_input_tokens", "cache_read_input_tokens", "cached_tokens"),
        reasoning,
      ];
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
    if (!delta || ![delta[0], delta[1], delta[3], delta[4]].some((n) => n > 0)) return [];
    model = modelName(payload) ?? modelName(info) ?? model ?? "gpt-5";
    const cached = Math.min(delta[0], delta[3]);
    const pricingModel =
      model === "gpt-reserve"
        ? "gpt-5.6-luna"
        : model === "codex-auto-review"
          ? autoReviewModel(
              typeof row.timestamp === "string"
                ? row.timestamp.slice(0, 10)
                : new Date(at).toISOString().slice(0, 10),
            )
          : undefined;
    return [
      {
        id: JSON.stringify([
          "codex",
          at,
          model,
          pricingModel,
          delta[0],
          cached,
          delta[1],
          delta[4],
          delta[2],
        ]),
        at,
        model,
        tokens: delta[2],
        costUsd: null,
        ...(pricingModel ? { pricingModel } : {}),
        tokenUsage: {
          input: Math.max(0, delta[0] - cached),
          output: delta[1],
          cacheRead: cached,
          cacheWrite: 0,
          cacheWrite1h: 0,
          fast,
        },
      },
    ];
  };
}

function autoReviewModel(date: string) {
  return (
    [
      ["2026-07-09", "gpt-5.6-luna"],
      ["2026-04-23", "gpt-5.5"],
      ["2026-03-05", "gpt-5.4"],
      ["2026-02-05", "gpt-5.3-codex"],
      ["2025-12-11", "gpt-5.2-codex"],
      ["2025-11-13", "gpt-5.1-codex"],
      ["2025-09-15", "gpt-5-codex"],
      ["2025-08-07", "gpt-5"],
    ].find(([released]) => date >= released)?.[1] ?? "gpt-5"
  );
}

export class HistoryCache {
  private views = new Map<LocalProvider, UsageHistory>();
  private pending = new Map<LocalProvider, Promise<void>>();
  private attempted = new Map<LocalProvider, number>();
  private files = new Map<string, CachedUsageFile>();
  private disposed = false;
  constructor(
    private changed: () => void,
    private home = os.homedir(),
    private env = process.env,
    private now = Date.now,
    private pricing?: () => Promise<ModelPricing>,
    private persistence?: HistoryFileStore,
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
    const now = this.now(),
      since = historyStart(now),
      cancelled = () => this.disposed;
    // OpenUsage scans from midnight 30 days ago; the UI displays today plus the previous 29 days.
    const scanSince = new Date(since);
    scanSince.setDate(scanSince.getDate() - 1);
    const discovered = await discoverHistory(provider, this.home, this.env, cancelled);
    const all: UsageEvent[][] = new Array(discovered.files.length);
    let partial = discovered.partial,
      nextIndex = 0,
      filesScanned = 0,
      oversizedRecords = 0,
      unreadableFiles = 0;
    const prefix = `${provider}\0${discovered.identity}\0`,
      seen = new Set<string>();
    for (const file of discovered.files) seen.add(prefix + file.path);
    const worker = async () => {
      for (;;) {
        await yieldToLoop();
        if (this.disposed) throw new Error("Scan cancelled");
        const index = nextIndex++;
        if (index >= discovered.files.length) return;
        const file = discovered.files[index],
          key = prefix + file.path;
        if (file.mtime < scanSince.getTime()) {
          all[index] = [];
          this.files.delete(key);
          continue;
        }
        filesScanned++;
        let cached = this.files.get(key);
        if (!cached || cached.size !== file.size || cached.mtime !== file.mtime) {
          cached = this.persistence?.get(provider, discovered.identity, file.path, file.size, file.mtime);
          if (!cached) {
            const parser = createLogParser(provider);
            const relevant =
              provider === "claude"
                ? /"usage"\s*:/
                : provider === "grok"
                  ? /turn_completed/
                  : /"type"\s*:\s*"(?:token_count|turn_context|session_meta|task_started|thread_settings_applied)"/;
            try {
              const result = await readJSONL(
                file,
                (line) => {
                  if (!relevant.test(line)) return [];
                  try {
                    return parser(JSON.parse(line));
                  } catch {
                    return [];
                  }
                },
                cancelled,
              );
              cached = {
                size: file.size,
                mtime: file.mtime,
                events: result.items,
                partial: result.partial,
                oversizedRecords: result.oversizedRecords,
              };
              if (this.disposed) throw new Error("Scan cancelled");
              // Avoid publishing an older parse after the source changed while it was read.
              const current = await fs.stat(file.path).catch(() => null);
              if (current?.size === file.size && current.mtimeMs === file.mtime) {
                try {
                  this.persistence?.put(provider, discovered.identity, file.path, cached);
                } catch {
                  /* Memory cache remains usable if persistence fails. */
                }
              }
            } catch (e) {
              if (this.disposed) throw e;
              partial = true;
              unreadableFiles++;
              this.files.delete(key);
              all[index] = [];
              continue;
            }
          }
          this.files.set(key, cached);
        }
        all[index] = cached.events;
        partial ||= cached.partial;
        oversizedRecords += cached.oversizedRecords ?? 0;
      }
    };
    const workers = await Promise.allSettled(
      Array.from({ length: Math.min(8, discovered.files.length) }, worker),
    );
    for (const result of workers) if (result.status === "rejected") throw result.reason;
    if (this.disposed) throw new Error("Scan cancelled");
    for (const key of this.files.keys()) if (key.startsWith(prefix) && !seen.has(key)) this.files.delete(key);
    try {
      this.persistence?.prune(
        provider,
        discovered.identity,
        new Set(discovered.files.map((f) => f.path)),
        scanSince.getTime(),
      );
    } catch {
      /* Persistence is optional. */
    }
    const events: UsageEvent[] = [];
    for (const items of all) for (const item of items ?? []) events.push(item);
    const pricing = events.some((e) => e.costUsd === null && e.tokenUsage)
      ? await this.pricing?.()
      : undefined;
    return {
      ...aggregateHistory(events, now, "local", partial, pricing),
      scan: { files: filesScanned, oversizedRecords, unreadableFiles },
    };
  }
}
