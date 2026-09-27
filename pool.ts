// Pure account-pool policy for one provider: names, reset times, rotation order.
// Nothing here touches the filesystem or bb, so it is covered by pool.test.ts.

export interface AccountMeta {
  name: string;
  email: string | null;
  /** Identity key from the login file, used to spot duplicates. */
  key: string;
  addedAt: number;
  /** Epoch ms until which the account is out of quota. 0 means usable. */
  exhaustedUntil: number;
  lastError: string | null;
  lastActivatedAt: number | null;
}

export interface PoolState {
  order: string[];
  active: string | null;
  accounts: Record<string, AccountMeta>;
  lastSwitchAt: number;
}

/** A fresh pool; never share one, its arrays are mutated in place. */
export function emptyPool(): PoolState {
  return { order: [], active: null, accounts: {}, lastSwitchAt: 0 };
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function validateName(name: string | undefined): string {
  const trimmed = (name ?? "").trim().toLowerCase();
  if (!NAME.test(trimmed)) {
    throw new Error(
      "Account name must be 1-32 chars of a-z, 0-9, - or _, starting with a letter or digit.",
    );
  }
  return trimmed;
}

/** "Resets in 2h51m28s" / "try again in 3h" → ms. Null when the message carries no reset time. */
export function parseResetMs(text: string | null | undefined): number | null {
  if (typeof text !== "string") return null;
  const match = /(?:Resets|try again) in\s+((?:\d+\s*[dhms]\s*)+)/i.exec(text);
  if (!match) return null;
  const units: Record<string, number> = {
    d: 86_400_000,
    h: 3_600_000,
    m: 60_000,
    s: 1_000,
  };
  let total = 0;
  for (const part of match[1].matchAll(/(\d+)\s*([dhms])/gi)) {
    total += Number(part[1]) * units[part[2].toLowerCase()];
  }
  return total > 0 ? total : null;
}

export function isUsable(meta: AccountMeta, now: number): boolean {
  return meta.exhaustedUntil <= now;
}

/**
 * The next usable account after `from` in pool order, wrapping around.
 * `from` itself is considered last, so a single usable account is returned.
 */
export function nextUsable(
  pool: PoolState,
  now: number,
  from: string | null = pool.active,
): string | null {
  const { order } = pool;
  if (order.length === 0) return null;
  const start = from ? order.indexOf(from) : -1;
  for (let step = 1; step <= order.length; step += 1) {
    const name = order[(start + step + order.length) % order.length];
    const meta = pool.accounts[name];
    if (meta && isUsable(meta, now)) return name;
  }
  return null;
}

/** Earliest time any account comes back, or null when the pool is empty. */
export function earliestReset(pool: PoolState): { name: string; at: number } | null {
  let best: { name: string; at: number } | null = null;
  for (const name of pool.order) {
    const meta = pool.accounts[name];
    if (!meta) continue;
    if (!best || meta.exhaustedUntil < best.at) {
      best = { name, at: meta.exhaustedUntil };
    }
  }
  return best;
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return "now";
  const minutes = Math.ceil(ms / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h${m.toString().padStart(2, "0")}m` : `${m}m`;
}

/** "Jane.Doe+ai@gmail.com" → "jane-doe-ai", unique within `taken`. */
export function nameFromEmail(email: string | null, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base =
    (email ?? "account")
      .split("@")[0]
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 28) || "account";
  let name = base;
  for (let n = 2; used.has(name); n += 1) name = `${base}-${n}`;
  return name;
}

/** Move `name` one step up or down in rotation order. */
export function moveInOrder(order: string[], name: string, direction: "up" | "down"): string[] {
  const index = order.indexOf(name);
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= order.length) return order;
  const next = [...order];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
