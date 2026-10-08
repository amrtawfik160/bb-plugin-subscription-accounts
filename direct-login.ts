// Claude Code and Codex logins saved by this plugin. The CLI still reads its own
// credential file. A Claude copy keeps the account id beside that file so a
// later token refresh stays on the same saved login.

import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import { nameFromEmail, parseResetMs } from "./pool.js";
import {
  SWAP_PROVIDERS,
  type ProviderId,
  type SwapProvider,
  readClaudeLocal,
  readCodexLocal,
} from "./providers.js";

export type LimitClass =
  | { kind: "none" }
  | { kind: "five-hour" | "weekly"; resetAt: number | null };

export interface StackLogin {
  provider: "claude" | "codex";
  name: string;
  key: string;
  email: string | null;
  body: string;
}

export interface FileLogin {
  id: ProviderId;
  label: string;
  tokenPath: string;
  profilePath: string | null;
  identify(stored: string): { key: string; email: string | null };
  liveBytes(stored: string): string;
  profileBytes(profile: string | null, stored: string): string | null;
  capture(live: string, profile: string | null): string | null;
  sameLive(
    meta: { key: string; email: string | null },
    live: string,
    profile: string | null,
  ): boolean;
  refreshStored(
    meta: { key: string; email: string | null },
    live: string,
    profile: string | null,
  ): string | null;
}

export interface PoolerSource {
  id: string;
  provider: "claude" | "codex";
  kind: string;
  email: string | null;
  label: string;
  enabled: boolean;
  priority: number;
  subscriptionType: string | null;
  rateLimitTier: string | null;
  accountUuid: string | null;
  codexAccountId: string | null;
}

export interface PoolerSnapshot {
  accounts: PoolerSource[];
  active: Partial<Record<"claude" | "codex", string>>;
}

const CLEAR_REASON = "Use the CLI login on this machine.";
const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/;
const NOT_A_LIMIT = /account-pool|Account Pooler|overloaded|at capacity|unauthorized|\b401\b|\b503\b/i;
const WEEKLY = /weekly|7-day|seven[- ]day/i;
const LIMITED = /5-hour|five[- ]hour|session limit|usage_limit_reached|rate_limit_error|hit your limit|usage limit/i;
const CLAUDE_SCOPES = ["user:inference", "user:profile", "user:sessions:claude_code", "user:mcp_servers"];

const oauthSecretSchema = z.object({
  kind: z.literal("oauth"),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number().nullable().optional(),
  idToken: z.string().nullable().optional(),
});

const sourceSchema = z.object({
  id: z.string(),
  provider: z.enum(["claude", "codex"]),
  kind: z.string(),
  email: z.string().nullable(),
  label: z.string(),
  enabled: z.boolean(),
  priority: z.number(),
  subscriptionType: z.string().nullable().optional(),
  rateLimitTier: z.string().nullable().optional(),
  accountUuid: z.string().nullable().optional(),
  codexAccountId: z.string().nullable().optional(),
});

const claudeStackSchema = z.object({
  kind: z.literal("claude-stack"),
  accountUuid: z.string(),
  email: z.string().nullable(),
  credentials: z.string().min(1),
});

type ClaudeStack = z.infer<typeof claudeStackSchema>;

function parseJson(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return undefined;
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseEnvelope(stored: string): ClaudeStack | null {
  const parsed = claudeStackSchema.safeParse(parseJson(stored));
  return parsed.success ? parsed.data : null;
}

function refreshTokenFromCredentials(credentials: string): string | null {
  const parsed = parseJson(credentials);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const oauth = "claudeAiOauth" in parsed ? parsed.claudeAiOauth : undefined;
  if (!oauth || typeof oauth !== "object" || Array.isArray(oauth)) return null;
  return "refreshToken" in oauth ? text(oauth.refreshToken) : null;
}

function sameEmail(left: string | null, right: string | null): boolean {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

function resetAtFrom(detail: string, now: number): number | null {
  const iso = ISO_TIME.exec(detail);
  if (iso) {
    const at = Date.parse(iso[0]);
    return Number.isFinite(at) ? at : null;
  }
  const relative = parseResetMs(detail);
  return relative === null ? null : now + relative;
}

export function classifySubscriptionLimit(detail: string, now: number): LimitClass {
  if (NOT_A_LIMIT.test(detail)) return { kind: "none" };
  const weekly = WEEKLY.test(detail);
  if (!weekly && !LIMITED.test(detail)) return { kind: "none" };
  const resetAt = resetAtFrom(detail, now);
  if (resetAt !== null && resetAt <= now) return { kind: "none" };
  return { kind: weekly ? "weekly" : "five-hour", resetAt };
}

export function directLoginEnv(providerId: "claude-code" | "codex"): {
  name: string;
  value: "";
  reason: string;
}[] {
  const names = providerId === "claude-code"
    ? ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]
    : ["CODEX_OPENAI_BASE_URL", "CODEX_POOL_AUTH_TOKEN"];
  return names.map((name) => ({ name, value: "", reason: CLEAR_REASON }));
}

export function directProviderForThread(bbProviderId: string | null | undefined): "claude" | "codex" | null {
  if (bbProviderId === "claude-code") return "claude";
  if (bbProviderId === "codex") return "codex";
  return null;
}

export function stackLoginFromPooler(
  account: PoolerSource,
  secretJson: string,
  taken: Iterable<string> = [],
): StackLogin | null {
  const source = sourceSchema.safeParse(account);
  if (!source.success || !source.data.enabled || source.data.kind !== "oauth") return null;
  const row = source.data;
  const secret = oauthSecretSchema.safeParse(parseJson(secretJson));
  if (!secret.success) return null;
  const name = nameFromEmail(row.email, taken);
  if (row.provider === "claude") {
    if (!row.accountUuid) return null;
    const credentials = JSON.stringify({
      claudeAiOauth: {
        accessToken: secret.data.accessToken,
        refreshToken: secret.data.refreshToken,
        expiresAt: secret.data.expiresAt ?? 0,
        scopes: CLAUDE_SCOPES,
        subscriptionType: row.subscriptionType ?? null,
        rateLimitTier: row.rateLimitTier ?? null,
      },
    });
    return {
      provider: "claude",
      name,
      key: row.accountUuid,
      email: row.email,
      body: JSON.stringify({
        kind: "claude-stack",
        accountUuid: row.accountUuid,
        email: row.email,
        credentials,
      }),
    };
  }
  if (!row.codexAccountId) return null;
  return {
    provider: "codex",
    name,
    key: row.codexAccountId,
    email: row.email,
    body: JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        access_token: secret.data.accessToken,
        refresh_token: secret.data.refreshToken,
        id_token: secret.data.idToken ?? null,
        account_id: row.codexAccountId,
      },
      last_refresh: new Date().toISOString(),
    }),
  };
}

export function identifyClaudeStored(stored: string): { key: string; email: string | null } {
  const envelope = parseEnvelope(stored);
  const credentials = envelope?.credentials ?? stored;
  const refresh = refreshTokenFromCredentials(credentials);
  if (!refresh) throw new Error("No refresh token. Sign in to Claude Code first.");
  if (!envelope) return { key: refresh.slice(-16), email: null };
  return {
    key: envelope.accountUuid || envelope.email || refresh.slice(-16),
    email: envelope.email,
  };
}

export function captureClaude(live: string, profile: string | null): string | null {
  const local = readClaudeLocal(live, profile);
  if (!local) return null;
  return JSON.stringify({
    kind: "claude-stack",
    accountUuid: local.accountId ?? "",
    email: local.email,
    credentials: live,
  });
}

function claudeSame(
  meta: { key: string; email: string | null },
  live: string,
  profile: string | null,
): boolean {
  const local = readClaudeLocal(live, profile);
  if (!local) return false;
  if (local.accountId && local.accountId === meta.key) return true;
  if (sameEmail(local.email, meta.email)) return true;
  const refresh = refreshTokenFromCredentials(live);
  return Boolean(refresh && refresh.slice(-16) === meta.key);
}

const claudeFile: FileLogin = {
  id: "claude",
  label: "Claude",
  tokenPath: ".claude/.credentials.json",
  profilePath: ".claude.json",
  identify: identifyClaudeStored,
  liveBytes(stored) {
    return parseEnvelope(stored)?.credentials ?? stored;
  },
  profileBytes(profile, stored) {
    const envelope = parseEnvelope(stored);
    if (!envelope) return null;
    const existing: Record<string, unknown> = {};
    if (profile) {
      const parsed = parseJson(profile);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("The Claude profile is invalid. Repair it before switching accounts.");
      }
      for (const [key, value] of Object.entries(parsed)) existing[key] = value;
    }
    return JSON.stringify({
      ...existing,
      oauthAccount: {
        accountUuid: envelope.accountUuid,
        emailAddress: envelope.email,
      },
    });
  },
  capture: captureClaude,
  sameLive: claudeSame,
  refreshStored(meta, live, profile) {
    if (!claudeSame(meta, live, profile)) return null;
    const local = readClaudeLocal(live, profile);
    return JSON.stringify({
      kind: "claude-stack",
      accountUuid: local?.accountId || meta.key,
      email: local?.email ?? meta.email,
      credentials: live,
    });
  },
};

function codexRefresh(stored: string): string | null {
  const parsed = parseJson(stored);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const tokens = "tokens" in parsed ? parsed.tokens : undefined;
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) return null;
  return "refresh_token" in tokens ? text(tokens.refresh_token) : null;
}

export function identifyCodexStored(stored: string): { key: string; email: string | null } {
  const local = readCodexLocal(stored);
  if (!local) throw new Error("No refresh token. Sign in to Codex first.");
  const refresh = codexRefresh(stored);
  return { key: local.accountId ?? (refresh ? refresh.slice(-16) : stored.slice(-16)), email: local.email };
}

function codexSame(meta: { key: string }, live: string): boolean {
  const local = readCodexLocal(live);
  if (!local) return false;
  if (local.accountId) return local.accountId === meta.key;
  const refresh = codexRefresh(live);
  return Boolean(refresh && refresh.slice(-16) === meta.key);
}

const codexFile: FileLogin = {
  id: "codex",
  label: "Codex",
  tokenPath: ".codex/auth.json",
  profilePath: null,
  identify: identifyCodexStored,
  liveBytes: (stored) => stored,
  profileBytes: () => null,
  capture(live) {
    return readCodexLocal(live) ? live : null;
  },
  sameLive(meta, live) {
    return codexSame(meta, live);
  },
  refreshStored(meta, live) {
    return codexSame(meta, live) ? live : null;
  },
};

function swapFile(provider: SwapProvider): FileLogin {
  return {
    id: provider.id,
    label: provider.label,
    tokenPath: provider.tokenPath,
    profilePath: null,
    identify: (stored) => provider.identify(stored),
    liveBytes: (stored) => stored,
    profileBytes: () => null,
    capture(live) {
      try {
        provider.identify(live);
        return live;
      } catch {
        return null;
      }
    },
    sameLive(meta, live) {
      try {
        return provider.identify(live).key === meta.key;
      } catch {
        return false;
      }
    },
    refreshStored(meta, live) {
      try {
        return provider.identify(live).key === meta.key ? live : null;
      } catch {
        return null;
      }
    },
  };
}

export function fileLoginFor(id: ProviderId): FileLogin {
  if (id === "claude") return claudeFile;
  if (id === "codex") return codexFile;
  return swapFile(SWAP_PROVIDERS[id]);
}

function sourceFrom(value: unknown): PoolerSource | null {
  const parsed = sourceSchema.safeParse(value);
  if (!parsed.success) return null;
  return {
    ...parsed.data,
    subscriptionType: parsed.data.subscriptionType ?? null,
    rateLimitTier: parsed.data.rateLimitTier ?? null,
    accountUuid: parsed.data.accountUuid ?? null,
    codexAccountId: parsed.data.codexAccountId ?? null,
  };
}

function readJsonRows(file: string, read: (db: DatabaseSync) => PoolerSnapshot): PoolerSnapshot | null {
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return read(db);
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export function readPoolerLogins(dataDir: string): PoolerSnapshot {
  const accounts = readJsonRows(`${dataDir}/bb.db`, (db) => {
    const row = db.prepare(
      "SELECT value FROM plugin_kv WHERE plugin_id = ? AND key = ?",
    ).get("account-pool", "accounts:v1");
    const value = row && typeof row.value === "string" ? parseJson(row.value) : undefined;
    const list = Array.isArray(value) ? value : [];
    return {
      accounts: list.flatMap((item) => {
        const source = sourceFrom(item);
        return source ? [source] : [];
      }),
      active: {},
    };
  }) ?? { accounts: [], active: {} };
  const active = readJsonRows(`${dataDir}/plugins/account-pool/data.db`, (db) => {
    const rows = db.prepare("SELECT provider, account_id FROM pool_active_account").all();
    const found: PoolerSnapshot["active"] = {};
    for (const row of rows) {
      const provider = row.provider;
      const accountId = row.account_id;
      if ((provider === "claude" || provider === "codex") && typeof accountId === "string" && accountId) {
        found[provider] = accountId;
      }
    }
    return { accounts: [], active: found };
  });
  return { accounts: accounts.accounts, active: active?.active ?? {} };
}
