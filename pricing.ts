import fs from "node:fs/promises";
import snapshot from "./pricing-data.json";
import { number, object } from "./usage.js";

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  fast?: boolean;
}
export interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
}
export interface ModelRates {
  base: Rates;
  long?: Rates & { threshold: number };
  fast?: Rates;
  fastLong?: Rates & { threshold: number };
  fastMultiplier?: number;
}
type Catalog = Record<string, ModelRates>;
type PricingData = {
  checkedAt: number;
  primary: Catalog;
  secondary: Catalog;
  supplement: Catalog;
  aliases: { pattern: string; canonical: string }[];
  fastMultipliers: Record<string, number>;
};
const price = (value: unknown) => {
  const n = number(value);
  return n !== null && n >= 0 && n < 1e6 ? n : null;
};
const scale = (r: Rates, factor: number): Rates => ({
  input: r.input * factor,
  output: r.output * factor,
  cacheRead: r.cacheRead * factor,
  cacheWrite: r.cacheWrite * factor,
  cacheWrite1h: r.cacheWrite1h * factor,
});
const normalize = (id: string) => id.toLowerCase().replace(/[.@]/g, "-");
const undated = (id: string) => id.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, "");

export function parseLiteLLM(value: unknown): Catalog {
  const models: Catalog = {};
  for (const [id, raw] of Object.entries(object(value))) {
    const e = object(raw),
      input = price(e.input_cost_per_token),
      output = price(e.output_cost_per_token);
    if (input === null || output === null) continue;
    const base: Rates = {
      input: input * 1e6,
      output: output * 1e6,
      cacheRead: (price(e.cache_read_input_token_cost) ?? input) * 1e6,
      cacheWrite: (price(e.cache_creation_input_token_cost) ?? input) * 1e6,
      cacheWrite1h: (price(e.cache_creation_input_token_cost_above_1hr) ?? input * 2) * 1e6,
    };
    const variant = (suffix: string): Rates | null => {
      const i = price(e[`input_cost_per_token${suffix}`]),
        o = price(e[`output_cost_per_token${suffix}`]);
      if (i === null || o === null) return null;
      return {
        input: i * 1e6,
        output: o * 1e6,
        cacheRead: (price(e[`cache_read_input_token_cost${suffix}`]) ?? i) * 1e6,
        cacheWrite: (price(e[`cache_creation_input_token_cost${suffix}`]) ?? i) * 1e6,
        cacheWrite1h: i * 2e6,
      };
    };
    const tier = [272000, 200000].find((n) => variant(`_above_${n / 1000}k_tokens`) !== null);
    const long = tier ? { ...variant(`_above_${tier / 1000}k_tokens`)!, threshold: tier } : undefined;
    const fast = variant("_priority");
    const fastLong = tier ? variant(`_above_${tier / 1000}k_tokens_priority`) : null;
    const multiplier = price(object(e.provider_specific_entry).fast);
    models[id] = {
      base,
      ...(long ? { long } : {}),
      ...(fast ? { fast } : {}),
      ...(fastLong && tier ? { fastLong: { ...fastLong, threshold: tier } } : {}),
      ...(multiplier && multiplier >= 1 ? { fastMultiplier: multiplier } : {}),
    };
  }
  if (!Object.keys(models).length) throw new Error("No model prices");
  return models;
}

export function parseModelsDev(value: unknown): Catalog {
  const models: Catalog = {};
  // Prefer first-party providers when the same slug also appears at resellers.
  const root = object(value);
  const providers = [...new Set(["openai", "anthropic", "xai", ...Object.keys(root).sort()])];
  for (const provider of providers)
    for (const [id, raw] of Object.entries(object(object(root[provider]).models))) {
      if (models[id]) continue;
      const c = object(object(raw).cost),
        input = price(c.input),
        output = price(c.output);
      if (input === null || output === null) continue;
      const rates = (c: Record<string, unknown>, input: number, output: number): Rates => ({
        input,
        output,
        cacheRead: price(c.cache_read) ?? input,
        cacheWrite: price(c.cache_write) ?? input,
        cacheWrite1h: input * 2,
      });
      const base = rates(c, input, output);
      const tier = (Array.isArray(c.tiers) ? c.tiers : [])
        .map(object)
        .find(
          (t) =>
            object(t.tier).type === "context" &&
            price(object(t.tier).size) !== null &&
            price(t.input) !== null &&
            price(t.output) !== null,
        );
      const long = tier
        ? {
            ...rates(tier, price(tier.input)!, price(tier.output)!),
            threshold: price(object(tier.tier).size)!,
          }
        : null;
      models[id] = { base, ...(long ? { long } : {}) };
    }
  if (!Object.keys(models).length) throw new Error("No model prices");
  return models;
}

export function parseSupplement(value: unknown): {
  supplement: Catalog;
  fastMultipliers: Record<string, number>;
} {
  const root = object(value),
    supplement: Catalog = {},
    fastMultipliers: Record<string, number> = {};
  for (const [id, raw] of Object.entries(object(root.pricing))) {
    const e = object(raw),
      input = price(e.input_per_million),
      output = price(e.output_per_million);
    if (input === null || output === null) continue;
    supplement[id] = {
      base: {
        input,
        output,
        cacheRead: price(e.cache_read_per_million) ?? input,
        cacheWrite: price(e.cache_write_per_million) ?? input,
        cacheWrite1h: input * 2,
      },
    };
  }
  for (const [id, raw] of Object.entries(object(root.fast_multipliers))) {
    const n = price(raw);
    if (n && n >= 1 && n <= 100) fastMultipliers[id] = n;
  }
  if (!Object.keys(supplement).length) throw new Error("No model prices");
  return { supplement, fastMultipliers };
}

export class ModelPricing {
  private memo = new Map<string, ModelRates | null>();
  private aliases: { pattern: RegExp; canonical: string }[];
  constructor(readonly data: PricingData) {
    this.aliases = data.aliases.map((rule) => ({
      pattern: new RegExp(rule.pattern.replace(/\(\?i\)/g, ""), "i"),
      canonical: rule.canonical,
    }));
  }
  resolve(model: string): ModelRates | null {
    const id = model.trim().toLowerCase().slice(0, 200);
    if (this.memo.has(id)) return this.memo.get(id)!;
    const alias = this.aliases.find((rule) => rule.pattern.test(id))?.canonical;
    const bare = id.split("/").at(-1)!;
    const names = [...new Set([alias, id, bare, undated(bare)].filter((v): v is string => !!v))];
    let found: ModelRates | null = null;
    // Fresh catalog entries take precedence over older supplement overrides.
    for (const catalog of [this.data.primary, this.data.supplement, this.data.secondary]) {
      for (const name of names)
        if (catalog[name]) {
          found = catalog[name];
          break;
        }
      if (found) break;
      const keys = Object.keys(catalog).filter((key) =>
        names.some((name) => normalize(undated(key)) === normalize(undated(name))),
      );
      keys.sort((a, b) => b.localeCompare(a));
      if (keys[0]) {
        found = catalog[keys[0]];
        break;
      }
    }
    const fastName = alias ?? bare;
    if (!found && fastName.endsWith("-fast")) {
      const baseName = fastName.slice(0, -5);
      const base = this.resolve(baseName);
      const multiplier = this.data.fastMultipliers[baseName] ?? base?.fastMultiplier;
      if (base && (base.fast || multiplier))
        found = {
          base: base.fast ?? scale(base.base, multiplier!),
          ...(base.fastLong
            ? { long: base.fastLong }
            : base.long && multiplier
              ? {
                  long: {
                    ...scale(base.long, multiplier),
                    threshold: base.long.threshold,
                  },
                }
              : {}),
        };
    }
    if (found && !found.fastMultiplier) {
      const multiplier = names.map((name) => this.data.fastMultipliers[name]).find(Boolean);
      if (multiplier) found = { ...found, fastMultiplier: multiplier };
    }
    this.memo.set(id, found);
    return found;
  }
  estimate(model: string, tokens: TokenUsage, request = true): number | null {
    const rates = this.resolve(model);
    if (!rates) return null;
    const values = [tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite, tokens.cacheWrite1h];
    if (values.some((n) => !Number.isFinite(n) || n < 0)) return null;
    const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.cacheWrite1h;
    const long = request && rates.long && prompt > rates.long.threshold;
    let selected: Rates = long ? rates.long! : rates.base;
    const namedFast = (this.aliases.find((rule) => rule.pattern.test(model))?.canonical ?? model).endsWith(
      "-fast",
    );
    if (tokens.fast && !namedFast) {
      const fastLong = request && rates.fastLong && prompt > rates.fastLong.threshold;
      if (fastLong) selected = rates.fastLong!;
      else if (rates.fast && !long) selected = rates.fast;
      else if (rates.fastMultiplier) selected = scale(selected, rates.fastMultiplier);
      else return null;
    }
    const result =
      (tokens.input * selected.input +
        tokens.output * selected.output +
        tokens.cacheRead * selected.cacheRead +
        tokens.cacheWrite * selected.cacheWrite +
        tokens.cacheWrite1h * selected.cacheWrite1h) /
      1e6;
    return Number.isFinite(result) ? result : null;
  }
}

export const PRICING_URLS = {
  primary: "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
  secondary: "https://models.dev/api.json",
  supplement: "https://robinebers.github.io/openusage/pricing_supplement.json",
};
const PRICING_TTL_MS = 60 * 60_000;

export class PricingStore {
  private data = snapshot as PricingData;
  private pending?: Promise<ModelPricing>;
  private attemptedAt: number | null = null;
  private initialized = false;
  constructor(
    private fetcher: typeof fetch = fetch,
    private signal?: AbortSignal,
    private cacheFile?: string,
    private now = Date.now,
  ) {}
  async current(): Promise<ModelPricing> {
    if (this.pending) return this.pending;
    if (this.attemptedAt !== null && this.now() - this.attemptedAt < PRICING_TTL_MS)
      return new ModelPricing(this.data);
    this.attemptedAt = this.now();
    this.pending = this.refresh().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private async fetchJson(url: string): Promise<unknown> {
    const timeout = AbortSignal.timeout(12_000);
    const response = await this.fetcher(url, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: this.signal ? AbortSignal.any([this.signal, timeout]) : timeout,
    });
    if (!response.ok || !response.body) throw new Error("Pricing unavailable");
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let bytes = 0,
      body = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 16 * 1024 * 1024) throw new Error("Pricing feed too large");
        body += decoder.decode(value, { stream: true });
      }
      body += decoder.decode();
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    return JSON.parse(body);
  }
  private async refresh(): Promise<ModelPricing> {
    if (!this.initialized) {
      this.initialized = true;
      if (this.cacheFile) {
        try {
          const raw = JSON.parse(await fs.readFile(this.cacheFile, "utf8"));
          if (
            number(raw.checkedAt) !== null &&
            raw.checkedAt >= this.data.checkedAt &&
            Object.keys(object(raw.primary)).length
          ) {
            // Disk cache is data only. Alias expressions always come from the reviewed bundled snapshot.
            const primary = validateCatalog(raw.primary);
            if (Object.keys(primary).length)
              this.data = {
                ...this.data,
                checkedAt: raw.checkedAt,
                primary,
                secondary: validateCatalog(raw.secondary),
                supplement: validateCatalog(raw.supplement),
                fastMultipliers: Object.fromEntries(
                  Object.entries(object(raw.fastMultipliers)).filter(
                    ([, n]) => price(n) !== null && Number(n) >= 1 && Number(n) <= 100,
                  ),
                ) as Record<string, number>,
              };
          }
        } catch {
          /* The bundled prices remain usable offline. */
        }
      }
    }
    if (this.signal?.aborted) return new ModelPricing(this.data);
    const results = await Promise.allSettled([
      this.fetchJson(PRICING_URLS.primary).then(parseLiteLLM),
      this.fetchJson(PRICING_URLS.secondary).then(parseModelsDev),
      this.fetchJson(PRICING_URLS.supplement).then(parseSupplement),
    ]);
    let next = { ...this.data };
    if (results[0].status === "fulfilled") next.primary = results[0].value;
    if (results[1].status === "fulfilled") next.secondary = results[1].value;
    if (results[2].status === "fulfilled") next = { ...next, ...results[2].value };
    if (results.every((result) => result.status === "fulfilled")) next.checkedAt = this.now();
    this.data = next;
    if (this.cacheFile && !this.signal?.aborted && results.some((r) => r.status === "fulfilled")) {
      const temporary = `${this.cacheFile}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify(this.data), {
          mode: 0o600,
        });
        await fs.rename(temporary, this.cacheFile);
      } catch {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
      }
    }
    return new ModelPricing(this.data);
  }
}

function validateCatalog(raw: unknown): Catalog {
  const result: Catalog = {};
  for (const [id, value] of Object.entries(object(raw))) {
    const e = object(value);
    const rates = (raw: unknown): Rates | null => {
      const r = object(raw),
        fields = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h"] as const;
      if (fields.some((k) => price(r[k]) === null)) return null;
      return Object.fromEntries(fields.map((k) => [k, price(r[k])!])) as unknown as Rates;
    };
    const base = rates(e.base);
    if (!base) continue;
    const long = rates(e.long),
      fast = rates(e.fast),
      fastLong = rates(e.fastLong),
      threshold = price(object(e.long).threshold),
      fastThreshold = price(object(e.fastLong).threshold),
      multiplier = price(e.fastMultiplier);
    result[id] = {
      base,
      ...(long && threshold ? { long: { ...long, threshold } } : {}),
      ...(fast ? { fast } : {}),
      ...(fastLong && fastThreshold ? { fastLong: { ...fastLong, threshold: fastThreshold } } : {}),
      ...(multiplier && multiplier >= 1 ? { fastMultiplier: multiplier } : {}),
    };
  }
  return result;
}
