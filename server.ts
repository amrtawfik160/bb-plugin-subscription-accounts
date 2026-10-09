// bb-plugin-subscription-accounts — stack several logins per AI subscription
// and move to the next one when an account runs out of quota.
//
// Each provider keeps its login in a file under HOME. This plugin saves a copy
// per account and swaps that file in. A stopped thread starts its next turn
// with a fresh CLI process that reads the new file. Claude Code and Codex use
// that same swap. Their provider environment is cleared so traffic does not go
// through the Account Pooler.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import {
  classifySubscriptionLimit,
  directLoginEnv,
  directProviderForThread,
  fileLoginFor,
  readPoolerLogins,
  stackLoginFromPooler,
  type FileLogin,
} from "./direct-login.js";
import { LoginSession, type LoginState, findBinary, stripAnsi } from "./login.js";
import { machineCredentials, readLoginFile, replaceLoginFiles } from "./machine-login.js";
import {
  type AccountMeta,
  emptyPool,
  type PoolState,
  earliestReset,
  formatDuration,
  isUsable,
  moveInOrder,
  nameFromEmail,
  nextUsable,
  parseResetMs,
  validateName,
} from "./pool.js";
import {
  type PoolAccount,
  pooler,
  poolQuotaMetrics,
  poolAccountIdentity,
} from "./pooler.js";
import {
  UsageCache,
  usageSchema,
  usageMetricSchema,
  UsageError,
} from "./usage.js";
import { createLocalUsageClient, createUsageClient } from "./usage-client.js";
import { HistoryCache } from "./history.js";
import { sqliteHistoryStore } from "./history-store.js";
import { PricingStore } from "./pricing.js";
import { historySchema } from "./history-schema.js";
import { quotaAccount, renderQuotas, type QuotaAccount, type QuotaReport } from "./quotas.js";
import {
  type PoolProviderId,
  SWAP_IDS,
  SWAP_PROVIDERS,
  CLI_LOGIN_SPECS,
  type SwapProvider,
  type SwapProviderId,
  type LocalLogin,
  isSwapId,
  readClaudeLocal,
  readCodexLocal,
  swapProviderForThread,
} from "./providers.js";

const run = promisify(execFile);

export const CHANGED = "accounts-changed";
/** A failure this soon after a switch most likely ran on the old account. */
const SWITCH_GRACE_MS = 60_000;
const RETRY_SLACK_MS = 15_000;
const TICK_MS = 60_000;

const stackIdSchema = z.enum(["antigravity", "cursor", "grok", "claude", "codex"]);
const poolIdSchema = z.enum(["claude", "codex"]);
const anyProviderSchema = stackIdSchema;
type StackId = z.infer<typeof stackIdSchema>;
const STACK_IDS: StackId[] = ["antigravity", "cursor", "grok", "claude", "codex"];
const POOLER_STAYS_OFF =
  "Claude and Codex switch inside Subscription Accounts. Leave the Account Pooler off.";

const swapAccountSchema = z.object({
  name: z.string(),
  email: z.string().nullable(),
  active: z.boolean(),
  exhaustedUntil: z.number(),
  lastError: z.string().nullable(),
  lastActivatedAt: z.number().nullable(),
  addedAt: z.number(),
  usage: usageSchema,
});

const loginSchema = z.object({
  id: z.string(),
  provider: z.string(),
  targetAccount: z.string().nullable(),
  status: z.enum(["starting", "waiting", "verifying", "done", "failed"]),
  url: z.string().nullable(),
  userCode: z.string().nullable(),
  needsCode: z.boolean(),
  expiresAt: z.number().nullable(),
  error: z.string().nullable(),
  account: z.string().nullable(),
});

const poolAccountSchema = z.object({
  id: z.string(),
  provider: poolIdSchema,
  label: z.string(),
  email: z.string().nullable(),
  subscriptionType: z.string().nullable(),
  enabled: z.boolean(),
  status: z.enum(["disabled", "ready", "held", "exhausted", "error"]),
  fiveHourUtilization: z.number().nullable(),
  fiveHourResetAt: z.number().nullable(),
  sevenDayUtilization: z.number().nullable(),
  sevenDayResetAt: z.number().nullable(),
  heldUntil: z.number().nullable(),
  error: z.string().nullable(),
  quotaMetrics: z.array(usageMetricSchema),
  canUseMachine: z.boolean(),
});

const localLoginSchema = z.object({
  email: z.string().nullable(),
  plan: z.string().nullable(),
  inStack: z.boolean(),
  stackAccountId: z.string().nullable(),
  usage: usageSchema,
});

const overviewSchema = z.object({
  now: z.number(),
  autoSwitch: z.boolean(),
  swap: z.array(
    z.object({
      id: stackIdSchema,
      label: z.string(),
      installed: z.boolean(),
      active: z.string().nullable(),
      accounts: z.array(swapAccountSchema),
      live: z.object({
        email: z.string().nullable(),
        saved: z.boolean(),
        signedIn: z.boolean(),
      }),
    }),
  ),
  pool: z.object({
    installed: z.boolean(),
    enabled: z.boolean(),
    routing: z.object({ claude: z.boolean(), codex: z.boolean() }),
    accounts: z.array(poolAccountSchema),
    error: z.string().nullable(),
    /** The subscription this machine's Claude Code / Codex CLI is signed into. */
    localLogin: z.object({
      claude: localLoginSchema.nullable(),
      codex: localLoginSchema.nullable(),
    }),
  }),
  login: loginSchema.nullable(),
  history: z.object({
    claude: historySchema,
    codex: historySchema,
    grok: historySchema,
  }),
});

const swapTarget = z.object({ provider: stackIdSchema, name: z.string() });
const ok = z.null();

export const rpcContract = defineRpcContract({
  overview: { input: z.null(), output: overviewSchema },
  setAutoSwitch: { input: z.object({ enabled: z.boolean() }), output: ok },
  use: { input: swapTarget, output: ok },
  markUsed: { input: swapTarget, output: ok },
  reset: { input: swapTarget, output: ok },
  remove: { input: swapTarget, output: ok },
  move: {
    input: swapTarget.extend({ direction: z.enum(["up", "down"]) }),
    output: ok,
  },
  saveCurrent: {
    input: z.object({ provider: stackIdSchema }),
    output: z.object({ name: z.string() }),
  },
  loginStart: {
    input: z.object({ provider: anyProviderSchema, name: z.string().optional() }),
    output: loginSchema,
  },
  loginSubmit: { input: z.object({ code: z.string() }), output: loginSchema },
  loginCancel: { input: z.null(), output: z.object({ kept: z.boolean() }) },
  poolEnable: { input: z.null(), output: ok },
  poolImport: { input: z.object({ provider: poolIdSchema }), output: ok },
  poolUse: { input: z.object({ id: z.string().min(1) }), output: ok },
  poolRemove: { input: z.object({ id: z.string() }), output: ok },
  poolToggle: {
    input: z.object({ id: z.string(), enabled: z.boolean() }),
    output: ok,
  },
  poolMove: {
    input: z.object({
      provider: poolIdSchema,
      id: z.string(),
      direction: z.enum(["up", "down"]),
    }),
    output: ok,
  },
  poolRouting: {
    input: z.object({ provider: poolIdSchema, enabled: z.boolean() }),
    output: ok,
  },
  poolRefresh: { input: z.object({ id: z.string() }), output: ok },
  usageRefresh: { input: swapTarget, output: ok },
  historyRefresh: {
    input: z.object({ provider: z.enum(["claude", "codex", "grok"]) }),
    output: ok,
  },
  localUsageRefresh: {
    input: z.object({ provider: poolIdSchema }),
    output: ok,
  },
});

export default async function plugin(bb: BbPluginApi) {
  for (const providerId of ["claude-code", "codex"] as const) {
    bb.providers.experimental_contributeEnv(providerId, () => directLoginEnv(providerId));
  }
  const usage = new UsageCache(() => changed());
  const usageController = new AbortController();
  const fetchUsage = createUsageClient(
    fetch,
    usageController.signal,
    async () => {
      const values = await settings.get();
      return values.antigravityOAuthClientId && values.antigravityOAuthClientSecret
        ? {
            clientId: values.antigravityOAuthClientId,
            clientSecret: values.antigravityOAuthClientSecret,
          }
        : null;
    },
    () => pricing.current(),
  );
  const fetchLocalUsage = createLocalUsageClient(fetch, usageController.signal);
  const localKeys: Partial<Record<PoolProviderId, string>> = {};
  const usageKey = (provider: StackId, name: string) => `${provider}/${name}`;
  const settings = bb.settings.define({
    autoSwitch: {
      type: "boolean",
      label: "Switch accounts automatically",
      default: true,
      description:
        "When a turn fails on a 5-hour or weekly limit, mark that account as used up, " +
        "switch to the next saved account, and retry the turn.",
    },
    fallbackCooldownMinutes: {
      type: "string",
      label: "Cooldown when no reset time is given (minutes)",
      default: "60",
    },
    antigravityOAuthClientId: {
      type: "string",
      label: "Antigravity OAuth client ID",
      secret: true,
      description: "The CLI's OAuth client. Required for refreshing expired Antigravity usage access.",
    },
    antigravityOAuthClientSecret: {
      type: "string",
      label: "Antigravity OAuth client secret",
      secret: true,
      description: "Stored outside the database and never sent to the page.",
    },
  });
  settings.onChange(() => changed());

  const db = bb.storage.database();
  const pricing = new PricingStore(
    fetch,
    usageController.signal,
    path.join(path.dirname(db.name), "pricing-cache.json"),
  );
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS tokens (
       provider TEXT NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL, updated_at INTEGER NOT NULL,
       PRIMARY KEY (provider, name))`,
    `CREATE TABLE IF NOT EXISTS usage_log_cache (
       provider TEXT NOT NULL, identity TEXT NOT NULL, path TEXT NOT NULL,
       size INTEGER NOT NULL, mtime REAL NOT NULL, schema_version INTEGER NOT NULL,
       body TEXT NOT NULL, updated_at INTEGER NOT NULL,
       PRIMARY KEY (provider, identity, path))`,
  ]);
  // The database holds refresh tokens; keep it owner-only like the CLIs' own files.
  await restrictToOwner(db.name);
  const history = new HistoryCache(
    () => changed(),
    undefined,
    undefined,
    undefined,
    () => pricing.current(),
    sqliteHistoryStore(db),
  );
  bb.onDispose(() => {
    usage.dispose();
    history.dispose();
    usageController.abort();
  });

  const pool = pooler(bb);

  function changed(): void {
    bb.realtime.publish(CHANGED, null);
  }

  // Background refreshes are not awaited; a rejection must never reach the host process.
  function logBackground(error: unknown): void {
    bb.log.warn(`Background refresh failed: ${(error as Error)?.message ?? String(error)}`);
  }

  // Every pool mutation goes through this chain, so concurrent failures from
  // several threads on the same exhausted account switch only once.
  let chain: Promise<unknown> = Promise.resolve();
  function serialized<T>(task: () => Promise<T>): Promise<T> {
    const result = chain.then(task, task);
    chain = result.catch(() => undefined);
    return result;
  }

  async function fallbackCooldownMs(): Promise<number> {
    const minutes = Number((await settings.get()).fallbackCooldownMinutes);
    return (Number.isFinite(minutes) && minutes > 0 ? minutes : 60) * 60_000;
  }

  // ── swap provider storage ────────────────────────────────────────────────

  async function loadPool(id: StackId): Promise<PoolState> {
    const stored = await bb.storage.kv.get<PoolState>(`pool:${id}`);
    const state = { ...emptyPool(), ...stored };
    // Drop names without a saved account so one bad write cannot wedge a list.
    state.order = state.order.filter((name) => state.accounts[name]);
    if (state.active && !state.accounts[state.active]) state.active = null;
    return state;
  }

  async function savePool(id: StackId, state: PoolState): Promise<void> {
    await bb.storage.kv.set(`pool:${id}`, state);
    changed();
  }

  function mutate<T>(id: StackId, change: (state: PoolState) => Promise<T>): Promise<T> {
    return serialized(async () => {
      const state = await loadPool(id);
      const result = await change(state);
      await savePool(id, state);
      return result;
    });
  }

  function requireAccount(state: PoolState, raw: string): AccountMeta {
    const meta = state.accounts[validateName(raw)];
    if (!meta) throw new Error(`No account named "${raw}".`);
    return meta;
  }

  function readToken(provider: StackId, name: string): string | null {
    const row = db.prepare("SELECT body FROM tokens WHERE provider = ? AND name = ?").get(provider, name) as
      { body: string } | undefined;
    return row?.body ?? null;
  }

  function writeToken(provider: StackId, name: string, body: string): void {
    db.prepare(
      "INSERT INTO tokens (provider, name, body, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(provider, name) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at",
    ).run(provider, name, body, Date.now());
  }

  function deleteToken(provider: StackId, name: string): void {
    db.prepare("DELETE FROM tokens WHERE provider = ? AND name = ?").run(provider, name);
  }

  function loginFile(login: FileLogin): string {
    return path.join(os.homedir(), login.tokenPath);
  }

  async function readLiveRaw(login: FileLogin): Promise<string | null> {
    return readLoginFile(loginFile(login));
  }

  async function readProfile(login: FileLogin): Promise<string | null> {
    if (!login.profilePath) return null;
    return readLoginFile(path.join(os.homedir(), login.profilePath));
  }

  /** Replace the CLI login only when it still matches the bytes we read. */
  async function writeLive(login: FileLogin, stored: string): Promise<void> {
    const target = loginFile(login);
    const before = await readLoginFile(target);
    const files: { path: string; before: string | null; after: string }[] = [];
    if (login.profilePath) {
      const profilePath = path.join(os.homedir(), login.profilePath);
      const profile = await readLoginFile(profilePath);
      const patched = login.profileBytes(profile, stored);
      if (patched !== null) files.push({ path: profilePath, before: profile, after: patched });
    }
    files.push({ path: target, before, after: login.liveBytes(stored) });
    await replaceLoginFiles(files);
  }

  /** The CLIs refresh their tokens in place; copy that back into the active slot. */
  async function syncActive(login: FileLogin, state: PoolState): Promise<boolean> {
    if (!state.active) return false;
    const meta = state.accounts[state.active];
    const live = await readLiveRaw(login);
    if (!meta || !live) return false;
    const profile = await readProfile(login);
    if (!login.sameLive(meta, live, profile)) return false;
    const stored = login.refreshStored(meta, live, profile);
    if (!stored || readToken(login.id, state.active) === stored) return false;
    writeToken(login.id, state.active, stored);
    return true;
  }

  async function activate(login: FileLogin, state: PoolState, name: string): Promise<void> {
    const body = readToken(login.id, name);
    if (!body) throw new Error(`No saved login for "${name}". Add it again.`);
    await syncActive(login, state);
    await writeLive(login, body);
    state.active = name;
    state.lastSwitchAt = Date.now();
    state.accounts[name].lastActivatedAt = state.lastSwitchAt;
  }

  async function whoami(provider: SwapProvider, home?: string): Promise<string | null> {
    if (!provider.whoami) return null;
    const binary = await findBinary(provider.whoami.binary);
    if (!binary) return null;
    try {
      const { stdout } = await run(binary, provider.whoami.args, {
        timeout: 20_000,
        env: home ? { ...process.env, HOME: home } : process.env,
      });
      return provider.whoami.pattern.exec(stripAnsi(stdout))?.[1] ?? null;
    } catch {
      return null;
    }
  }

  // ── swap operations shared by the CLI and the page ───────────────────────

  async function addAccount(
    login: FileLogin,
    rawName: string | undefined,
    body: string,
    options: {
      force?: boolean;
      makeActive?: boolean;
      home?: string;
      beforeCommit?: () => void;
    } = {},
  ): Promise<string> {
    const identity = login.identify(body);
    const swap = isSwapId(login.id) ? SWAP_PROVIDERS[login.id] : null;
    const email = identity.email ?? (swap ? await whoami(swap, options.home) : null);
    options.beforeCommit?.();
    return mutate(login.id, async (state) => {
      const clash = Object.values(state.accounts).find((meta) => meta.key === identity.key);
      const name = rawName?.trim()
        ? validateName(rawName)
        : (clash?.name ?? nameFromEmail(email, state.order));
      if (clash && clash.name !== name && !options.force) {
        throw new Error(`${email ?? "That login"} is already saved as "${clash.name}".`);
      }
      if (state.accounts[name] && state.accounts[name].key !== identity.key && !options.force) {
        throw new Error(`"${name}" already exists. Pass --force to replace its login.`);
      }
      writeToken(login.id, name, body);
      usage.remove(usageKey(login.id, name));
      const meta: AccountMeta = state.accounts[name] ?? {
        name,
        email,
        key: identity.key,
        addedAt: Date.now(),
        exhaustedUntil: 0,
        lastError: null,
        lastActivatedAt: null,
      };
      Object.assign(meta, {
        email: email ?? meta.email,
        key: identity.key,
        exhaustedUntil: 0,
        lastError: null,
      });
      state.accounts[name] = meta;
      if (!state.order.includes(name)) state.order.push(name);
      if (!state.active && options.makeActive) state.active = name;
      return name;
    });
  }

  async function saveCurrent(login: FileLogin, rawName?: string, force = false): Promise<string> {
    const live = await readLiveRaw(login);
    const stored = live ? login.capture(live, await readProfile(login)) : null;
    if (!stored) throw new Error(`${login.label} is not signed in on this machine.`);
    return addAccount(login, rawName, stored, { force, makeActive: true });
  }

  const useAccount = (login: FileLogin, raw: string) =>
    mutate(login.id, async (state) => {
      const meta = requireAccount(state, raw);
      await activate(login, state, meta.name);
      return meta;
    });

  const markUsed = (login: FileLogin, raw: string) =>
    mutate(login.id, async (state) => {
      const meta = requireAccount(state, raw);
      meta.exhaustedUntil = Date.now() + (await fallbackCooldownMs());
      if (state.active !== meta.name) return null;
      const next = nextUsable(state, Date.now());
      if (next && next !== meta.name) await activate(login, state, next);
      return next;
    });

  const resetAccounts = (login: FileLogin, names: string[] | null) =>
    mutate(login.id, async (state) => {
      const targets = names ?? state.order;
      for (const name of targets) {
        const meta = requireAccount(state, name);
        meta.exhaustedUntil = 0;
        meta.lastError = null;
      }
      return targets;
    });

  const removeAccount = (login: FileLogin, raw: string) =>
    mutate(login.id, async (state) => {
      const meta = requireAccount(state, raw);
      delete state.accounts[meta.name];
      state.order = state.order.filter((n) => n !== meta.name);
      deleteToken(login.id, meta.name);
      usage.remove(usageKey(login.id, meta.name));
      if (state.active === meta.name) state.active = null;
    });

  const moveAccount = (login: FileLogin, raw: string, direction: "up" | "down") =>
    mutate(login.id, async (state) => {
      state.order = moveInOrder(state.order, requireAccount(state, raw).name, direction);
    });

  // ── automatic switching ──────────────────────────────────────────────────

  async function latestProviderError(threadId: string): Promise<string | null> {
    const events = await bb.sdk.threads.events.list({
      threadId,
      order: "desc",
      types: ["provider/error"],
      limit: "1",
    });
    const data = events[0]?.data as { detail?: unknown; message?: unknown } | undefined;
    if (!data) return null;
    if (typeof data.detail === "string") return data.detail;
    return typeof data.message === "string" ? data.message : null;
  }

  /** Stop releases the thread's loaded CLI, so the retry starts one that reads the new login. */
  async function restartAndRetry(
    threadId: string,
    requestId: string,
    reason: string,
    sendAt?: number,
  ): Promise<void> {
    await bb.sdk.threads.stop({ threadId }).catch(() => undefined);
    await bb.sdk.threads.retry({
      threadId,
      turnRequestId: requestId,
      reason,
      ...(sendAt ? { sendAt } : {}),
    });
  }

  async function handleFailure(event: { threadId: string; requestId: string; attemptNumber: number }) {
    if (!(await settings.get()).autoSwitch) return;
    const thread = await bb.sdk.threads.get({ threadId: event.threadId });
    const swap = swapProviderForThread(thread.providerId);
    const directId = directProviderForThread(thread.providerId);
    if (!swap && !directId) return;
    const error = await latestProviderError(event.threadId);
    if (!error) return;
    const now = Date.now();
    let login: FileLogin;
    let resetMs: number;
    let quoteReset: boolean;
    if (swap) {
      if (!swap.quota.test(error)) return;
      resetMs = parseResetMs(error) ?? (await fallbackCooldownMs());
      login = fileLoginFor(swap.id);
      quoteReset = false;
    } else if (directId) {
      const limit = classifySubscriptionLimit(error, now);
      if (limit.kind === "none") return;
      if (limit.resetAt !== null && limit.resetAt <= now) return;
      resetMs = limit.resetAt === null ? await fallbackCooldownMs() : limit.resetAt - now;
      login = fileLoginFor(directId);
      quoteReset = true;
    } else {
      return;
    }

    await serialized(async () => {
      const state = await loadPool(login.id);
      if (state.order.length === 0) return;
      if (event.attemptNumber > state.order.length + 1) {
        bb.log.warn(`${event.threadId}: giving up after ${event.attemptNumber} attempts`);
        return;
      }

      const onOldAccount = event.attemptNumber === 1 && now - state.lastSwitchAt < SWITCH_GRACE_MS;
      if (!onOldAccount) {
        const meta = state.active ? state.accounts[state.active] : undefined;
        if (meta) {
          meta.exhaustedUntil = now + resetMs;
          meta.lastError = error.slice(0, 300);
          bb.log.info(`${login.id}/${meta.name} out of quota for ${formatDuration(resetMs)}`);
        }
        const next = nextUsable(state, now);
        if (next && next !== state.active) {
          const from = state.active;
          await activate(login, state, next);
          bb.log.info(`${login.id}: switched ${from ?? "(none)"} -> ${next}`);
        } else if (!next) {
          const soonest = earliestReset(state);
          await savePool(login.id, state);
          if (!soonest) return;
          const when = quoteReset
            ? ` The earliest reset is ${new Date(soonest.at).toISOString()} (${soonest.name}).`
            : ` Retrying when ${soonest.name} resets.`;
          await restartAndRetry(
            event.threadId,
            event.requestId,
            `All ${login.label} accounts are out of quota.${when}`,
            soonest.at + RETRY_SLACK_MS,
          );
          return;
        }
      }
      await savePool(login.id, state);
      await restartAndRetry(
        event.threadId,
        event.requestId,
        `${login.label} quota reached. Continuing on ${state.active}.`,
      );
    });
  }

  bb.events.on("turn.failed", (event) =>
    handleFailure(event).catch((error: unknown) => {
      bb.log.error(`quota switch failed for ${event.threadId}: ${(error as Error)?.message ?? error}`);
    }),
  );

  // Keeps saved tokens fresh and moves back onto an account once its quota
  // resets, so a retry queued for "when X resets" runs on X.
  bb.background.service("rotation-tick", {
    async start(signal) {
      while (!signal.aborted) {
        for (const id of STACK_IDS) {
          const login = fileLoginFor(id);
          try {
            await serialized(async () => {
              const state = await loadPool(id);
              let dirty = await syncActive(login, state);
              const now = Date.now();
              const active = state.active ? state.accounts[state.active] : undefined;
              if (active && !isUsable(active, now)) {
                const next = nextUsable(state, now);
                if (next && next !== state.active) {
                  await activate(login, state, next);
                  dirty = true;
                  bb.log.info(`${id}: quota reset, now on ${next}`);
                }
              }
              if (dirty) await savePool(id, state);
            });
          } catch (error) {
            bb.log.warn(`${id} tick failed: ${(error as Error).message}`);
          }
        }
        await sleep(TICK_MS, signal);
      }
    },
  });

  // ── sign-in, one at a time, for every provider ───────────────────────────

  let login: LoginState | null = null;
  let swapLogin: LoginSession | null = null;
  let codexPoll: { sessionId: string; timer: NodeJS.Timeout } | null = null;
  let claudeSessionId: string | null = null;

  function stopLogins(): void {
    swapLogin?.cancel();
    swapLogin = null;
    if (codexPoll) {
      clearTimeout(codexPoll.timer);
      void pool.codexLoginCancel(codexPoll.sessionId).catch(() => undefined);
      codexPoll = null;
    }
    claudeSessionId = null;
  }

  function loginState(provider: string, patch: Partial<LoginState>): LoginState {
    login = {
      id: `${provider}-${Date.now()}`,
      provider,
      targetAccount: null,
      status: "starting",
      url: null,
      userCode: null,
      needsCode: false,
      expiresAt: null,
      error: null,
      account: null,
      ...patch,
    };
    changed();
    return login;
  }

  function updateLogin(patch: Partial<LoginState>): void {
    if (!login) return;
    login = { ...login, ...patch };
    changed();
  }

  async function startLogin(provider: z.infer<typeof anyProviderSchema>, name?: string): Promise<LoginState> {
    return serialized(async () => {
      if (swapLogin?.active) throw new Error("Finish or cancel the current sign-in first.");
      const fileLogin = fileLoginFor(provider);
      const spec = isSwapId(provider) ? SWAP_PROVIDERS[provider].login : CLI_LOGIN_SPECS[provider];
      const expected = name === undefined ? null : { ...requireAccount(await loadPool(provider), name) };
      const binary = await findBinary(spec.binary);
      if (!binary) throw new Error(`${spec.binary} is not installed on this machine.`);
      const home = path.join(stagingRoot(), `${provider}-${Date.now()}`);
      const session = new LoginSession(
        provider,
        spec,
        home,
        fileLogin.tokenPath,
        () => {
          if (swapLogin === session) {
            login = { ...session.state };
            changed();
          }
        },
        async (tokenFile, sessionHome) => {
          const cancelled = () => {
            throw new Error("Sign-in cancelled. Your saved login was kept.");
          };
          const ensureActive = () => {
            if (!session.active) cancelled();
          };
          const raw = await fs.readFile(tokenFile, "utf8");
          const stagedProfilePath = provider === "claude" ? ".claude/.claude.json" : fileLogin.profilePath;
          const profile = stagedProfilePath
            ? await readLoginFile(path.join(sessionHome, stagedProfilePath)) : null;
          if ((provider === "claude" && !readClaudeLocal(raw, profile)?.accountId) ||
              (provider === "codex" && !readCodexLocal(raw)?.accountId)) {
            throw new Error("Sign-in did not save a verified account identity. Try again.");
          }
          const body = fileLogin.capture(raw, profile);
          if (!body) throw new Error("Sign-in did not save a usable subscription login. Try again.");
          ensureActive();
          if (!expected) {
            return addAccount(fileLogin, undefined, body, {
              makeActive: provider !== "claude" && provider !== "codex",
              home: sessionHome,
              beforeCommit: () => {
                ensureActive();
                session.markCommitted();
              },
            });
          }
          const identity = fileLogin.identify(body);
          const email = identity.email ?? (isSwapId(provider) ? await whoami(SWAP_PROVIDERS[provider], sessionHome) : null);
          ensureActive();
          const saved = await mutate(provider, async (state) => {
            const meta = requireAccount(state, expected.name);
            ensureActive();
            if (meta.addedAt !== expected.addedAt || meta.key !== expected.key) {
              throw new Error("This saved account changed during sign-in. Try again.");
            }
            const matchingEmail = provider !== "cursor" && provider !== "codex" && meta.email && email && meta.email.toLowerCase() === email.toLowerCase();
            if (identity.key !== meta.key && !matchingEmail) {
              throw new Error(`Sign in with ${meta.email ?? meta.name}. Your saved login was kept.`);
            }
            const previous = readToken(provider, meta.name);
            const liveProfile = await readProfile(fileLogin);
            const liveMatches = Boolean(
              state.active === meta.name && previous &&
              (await readLiveRaw(fileLogin)) === fileLogin.liveBytes(previous) &&
              fileLogin.sameLive(meta, fileLogin.liveBytes(previous), liveProfile),
            );
            ensureActive();
            session.markCommitted();
            if (liveMatches) {
              const files: { path: string; before: string | null; after: string }[] = [
                { path: loginFile(fileLogin), before: fileLogin.liveBytes(previous!), after: fileLogin.liveBytes(body) },
              ];
              const patched = fileLogin.profileBytes(liveProfile, body);
              if (fileLogin.profilePath && patched !== null) {
                files.unshift({ path: path.join(os.homedir(), fileLogin.profilePath), before: liveProfile, after: patched });
              }
              await replaceLoginFiles(files);
            }
            writeToken(provider, meta.name, body);
            meta.key = identity.key;
            meta.email = email ?? meta.email;
            meta.lastError = null;
            usage.remove(usageKey(provider, meta.name));
            return meta.name;
          });
          await refreshUsage(provider, saved, true, { syncLive: false });
          return saved;
        },
        expected?.name ?? null,
        (message) => bb.log.warn(message),
      );
      swapLogin = session;
      login = { ...session.state };
      await session.start(binary);
      return login;
    });
  }

  async function submitLogin(code: string): Promise<LoginState> {
    if (!login) throw new Error("No sign-in in progress. Start again.");
    if (login.provider === "claude" && !swapLogin) {
      if (!claudeSessionId) throw new Error("This sign-in expired. Start again.");
      updateLogin({ status: "verifying" });
      try {
        const account = await pool.claudeLoginComplete(claudeSessionId, code.trim());
        claudeSessionId = null;
        updateLogin({
          status: "done",
          account: account.email ?? account.label,
        });
      } catch (error) {
        updateLogin({ status: "failed", error: (error as Error).message });
      }
      return login;
    }
    if (!swapLogin) throw new Error("This sign-in does not take a code.");
    swapLogin.submitCode(code);
    login = { ...swapLogin.state };
    return login;
  }

  function sameStackIdentity(
    provider: "claude" | "codex",
    row: { key: string; email: string | null },
    identity: { key: string; email: string | null },
  ): boolean {
    if (row.key === identity.key) return true;
    return provider === "claude" && Boolean(
      identity.email && row.email && identity.email.toLowerCase() === row.email.toLowerCase(),
    );
  }

  async function readPoolerSecret(id: string): Promise<string | null> {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) return null;
    try {
      return await fs.readFile(
        path.join(bb.server.experimental_dataDir, "plugins/account-pool/secrets/accounts", `account-${id}.json`),
        "utf8",
      );
    } catch {
      return null;
    }
  }

  /** Copy enabled pooler logins once. Never writes the CLI file or changes those accounts. */
  async function importDirectLogins(): Promise<void> {
    const snapshot = readPoolerLogins(bb.server.experimental_dataDir);
    for (const provider of ["claude", "codex"] as const) {
      try {
        await serialized(async () => {
          const state = await loadPool(provider);
          if (state.order.length > 0) return;
          const login = fileLoginFor(provider);
          const taken = new Set<string>();
          const rows: {
            name: string;
            key: string;
            email: string | null;
            body: string;
            sourceId: string | null;
          }[] = [];
          const enabled = snapshot.accounts
            .filter((account) => account.provider === provider && account.enabled)
            .sort((left, right) => left.priority - right.priority);
          for (const account of enabled) {
            const secret = await readPoolerSecret(account.id);
            if (!secret) continue;
            const saved = stackLoginFromPooler(account, secret, taken);
            if (!saved) continue;
            taken.add(saved.name);
            rows.push({
              name: saved.name,
              key: saved.key,
              email: saved.email,
              body: saved.body,
              sourceId: account.id,
            });
          }
          const live = await readLiveRaw(login);
          const profile = await readProfile(login);
          const captured = live ? login.capture(live, profile) : null;
          let liveIdentity: { key: string; email: string | null } | null = null;
          if (captured) {
            try {
              liveIdentity = login.identify(captured);
            } catch {
              liveIdentity = null;
            }
          }
          if (captured && liveIdentity) {
            const identity = liveIdentity;
            if (!rows.some((row) => sameStackIdentity(provider, row, identity))) {
              const name = nameFromEmail(identity.email, taken);
              rows.unshift({
                name,
                key: identity.key,
                email: identity.email,
                body: captured,
                sourceId: null,
              });
            }
          }
          if (rows.length === 0) return;
          const now = Date.now();
          for (const row of rows) {
            writeToken(provider, row.name, row.body);
            state.accounts[row.name] = {
              name: row.name,
              email: row.email,
              key: row.key,
              addedAt: now,
              exhaustedUntil: 0,
              lastError: null,
              lastActivatedAt: null,
            };
            state.order.push(row.name);
          }
          let matchedLive: (typeof rows)[number] | undefined;
          if (liveIdentity) {
            const identity = liveIdentity;
            matchedLive = rows.find((row) => sameStackIdentity(provider, row, identity));
          }
          const poolerId = snapshot.active[provider];
          const matchedPooler = poolerId ? rows.find((row) => row.sourceId === poolerId) : undefined;
          state.active = matchedLive?.name ?? matchedPooler?.name ?? null;
          await savePool(provider, state);
        });
      } catch (error) {
        bb.log.warn(`${provider} login import failed: ${(error as Error).message}`);
      }
    }
  }

  await importDirectLogins();

  // ── page RPC ─────────────────────────────────────────────────────────────

  function refreshUsage(provider: StackId, name: string, force = false, options = { syncLive: true }) {
    const login = fileLoginFor(provider);
    if (provider === "claude" || provider === "codex") {
      return usage.refresh(
        usageKey(provider, name),
        async () => {
          let stored: string | null = null;
          await serialized(async () => {
            const state = await loadPool(provider);
            requireAccount(state, name);
            if (options.syncLive) await syncActive(login, state);
            stored = readToken(provider, name);
          });
          if (!stored) throw new UsageError("No saved login. Add this account again.");
          const expectedCredentials = login.liveBytes(stored);
          return fetchLocalUsage(provider, expectedCredentials, {
            save: async (updated, expected) =>
              serialized(async () => {
                const current = readToken(provider, name);
                if (!current || login.liveBytes(current) !== expected) return false;
                const state = await loadPool(provider);
                const meta = state.accounts[name];
                if (!meta) return false;
                const profile = await readProfile(login);
                const nextStored = login.refreshStored(meta, updated, profile);
                if (!nextStored) return false;
                if (state.active === name && (await readLiveRaw(login)) === login.liveBytes(current)) {
                  await writeLive(login, nextStored);
                }
                writeToken(provider, name, nextStored);
                return true;
              }),
          });
        },
        force,
      );
    }
    return usage.refresh(
      usageKey(provider, name),
      async () => {
        let body: string | null = null;
        await serialized(async () => {
          const state = await loadPool(provider);
          requireAccount(state, name);
          if (options.syncLive) await syncActive(login, state);
          body = readToken(provider, name);
        });
        if (!body) throw new UsageError("No saved login. Add this account again.");
        let expectedBody: string = body;
        return fetchUsage(provider, body, async (updated) => {
          await serialized(async () => {
            // A CLI refresh, replacement login or removal can win while fetching.
            // Never overwrite that newer credential or swap the current account.
            if (readToken(provider, name) !== expectedBody) return;
            const state = await loadPool(provider);
            if (!state.accounts[name]) return;
            if (state.active === name && (await readLiveRaw(login)) === expectedBody) {
              await writeLive(login, updated);
            }
            writeToken(provider, name, updated);
            expectedBody = updated;
          });
        });
      },
      force,
    );
  }

  function toPoolAccount(
    account: PoolAccount,
  ): z.infer<typeof poolAccountSchema> {
    return {
      id: account.id,
      provider: account.provider,
      label: account.label,
      email: account.email,
      subscriptionType: account.subscriptionType ?? null,
      enabled: account.enabled,
      status: account.status,
      fiveHourUtilization: account.fiveHourUtilization ?? null,
      fiveHourResetAt: account.fiveHourResetAt ?? null,
      sevenDayUtilization: account.sevenDayUtilization ?? null,
      sevenDayResetAt: account.sevenDayResetAt ?? null,
      heldUntil: account.heldUntil ?? null,
      error: account.error ?? null,
      quotaMetrics: poolQuotaMetrics(account),
      canUseMachine: account.kind === "oauth",
    };
  }

  async function readOptional(file: string): Promise<string | null> {
    return fs.readFile(file, "utf8").catch(() => null);
  }

  const localCredentialPath = (provider: PoolProviderId) =>
    path.join(os.homedir(), provider === "claude" ? ".claude/.credentials.json" : ".codex/auth.json");
  function localCredentialStore(
    provider: PoolProviderId,
    expectedAccountId?: string,
  ) {
    const target = localCredentialPath(provider);
    return {
      expectedAccountId,
      reload: () => readOptional(target),
      save: (updated: string, expected: string) =>
        serialized(async () => {
          if ((await readOptional(target)) !== expected) return false;
          const temp = `${target}.${process.pid}.usage-refresh`;
          try {
            await fs.writeFile(temp, updated, { mode: 0o600 });
            if ((await readOptional(target)) !== expected) return false;
            await fs.rename(temp, target);
            return true;
          } finally {
            await fs.rm(temp, { force: true });
          }
        }),
    };
  }

  const reconnecting = new Map<string, Promise<void>>();
  async function reconnectPoolAccount(account: PoolAccount) {
    const pending = reconnecting.get(account.id);
    if (pending) return pending;
    const task = performReconnect(account);
    reconnecting.set(account.id, task);
    try {
      await task;
    } finally {
      reconnecting.delete(account.id);
    }
  }
  async function performReconnect(account: PoolAccount) {
    const identity = poolAccountIdentity(account);
    if (!identity)
      throw new UsageError(
        "This saved account has no verified identity. Sign in again.",
      );
    const body = await readOptional(localCredentialPath(account.provider));
    if (!body)
      throw new UsageError(
        "Sign in to this account with its CLI, then refresh again.",
      );
    await fetchLocalUsage(
      account.provider,
      body,
      localCredentialStore(account.provider, identity),
    );
    const existingIds = new Set((await pool.view()).accounts.map((a) => a.id));
    const replacement = await pool.importLocal(
      account.provider,
      account.priority,
      account.label,
    );
    const reused = replacement.id === account.id;
    const discardReplacement = async () => {
      if (!existingIds.has(replacement.id)) await pool.remove(replacement.id);
    };
    if (poolAccountIdentity(replacement) !== identity) {
      await discardReplacement();
      throw new UsageError(
        "The CLI login changed during reconnect. Refresh again.",
      );
    }
    const current = await pool.view();
    const fresh = current.accounts.find((a) => a.id === replacement.id);
    if (!fresh || fresh.error || !poolQuotaMetrics(fresh).length) {
      await discardReplacement();
      throw new UsageError(
        "The replacement login could not fetch quotas. The saved account was kept.",
      );
    }
    if (reused) return;
    const order = current.accounts
      .filter((a) => a.provider === account.provider && a.id !== replacement.id)
      .map((a) => (a.id === account.id ? replacement.id : a.id));
    try {
      await pool.reorder(account.provider, [...order, account.id]);
    } catch (error) {
      await discardReplacement();
      throw error;
    }
    await pool.remove(account.id);
  }

  function localUsageKey(provider: PoolProviderId, body: string | null): string | null {
    const key = body ? `local/${provider}/${createHash("sha256").update(body).digest("hex")}` : null;
    if (localKeys[provider] && localKeys[provider] !== key) usage.remove(localKeys[provider]!);
    if (key) localKeys[provider] = key;
    else delete localKeys[provider];
    return key;
  }

  async function localLogins(accounts: PoolAccount[]) {
    const home = os.homedir();
    const [claudeCreds, claudeProfile, codexAuth] = await Promise.all([
      readOptional(path.join(home, ".claude", ".credentials.json")),
      readOptional(path.join(home, ".claude.json")),
      readOptional(path.join(home, ".codex", "auth.json")),
    ]);
    const mark = (
      provider: PoolProviderId,
      local: LocalLogin | null,
      body: string | null,
    ) => {
      if (!local || !body) {
        localUsageKey(provider, null);
        return null;
      }
      const key = localUsageKey(provider, body)!;
      usage.refresh(key, () =>
        fetchLocalUsage(provider, body, localCredentialStore(provider)),
      ).catch(logBackground);
      const matched = accounts.find((a) =>
        a.provider === provider && (local.accountId
          ? poolAccountIdentity(a) === local.accountId
          : local.email !== null && a.email?.toLowerCase() === local.email.toLowerCase()),
      );
      return {
        ...local,
        email: local.email ?? matched?.email ?? null,
        plan: local.plan ?? matched?.subscriptionType ?? null,
        inStack: Boolean(matched),
        stackAccountId: matched?.id ?? null,
        usage: usage.get(key),
      };
    };
    return {
      claude: mark("claude", readClaudeLocal(claudeCreds, claudeProfile), claudeCreds),
      codex: mark("codex", readCodexLocal(codexAuth), codexAuth),
    };
  }

  async function usePoolAccount(id: string) {
    await serialized(async () => {
      const view = await pool.view();
      if (view.error) throw new Error(view.error);
      const account = view.accounts.find((a) => a.id === id);
      if (!account) throw new Error("This saved account is unavailable. Refresh the account list.");
      const target = localCredentialPath(account.provider);
      const profilePath = path.join(os.homedir(), ".claude.json");
      const before = await readLoginFile(target);
      const profile = account.provider === "claude" ? await readLoginFile(profilePath) : null;
      const local = account.provider === "claude" ? readClaudeLocal(before, profile) : readCodexLocal(before);
      const matched = local && view.accounts.find((a) => a.provider === account.provider &&
        (local.accountId ? poolAccountIdentity(a) === local.accountId :
          local.email !== null && a.email?.toLowerCase() === local.email.toLowerCase()));
      if (matched?.id === id) return;
      // Validate the target before importing or touching the current login.
      await machineCredentials(bb.server.experimental_dataDir, account);
      if (local && !matched) {
        const priorities = view.accounts.filter((a) => a.provider === account.provider).map((a) => a.priority);
        await pool.importLocal(account.provider, priorities.length ? Math.max(...priorities) + 1 : 0);
      }
      const after = await machineCredentials(bb.server.experimental_dataDir, account);
      const files = [{ path: target, before, after }];
      if (account.provider === "claude") {
        let existing: Record<string, unknown>;
        try {
          const parsed = JSON.parse(profile ?? "{}");
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
          existing = parsed;
        } catch {
          throw new Error("The Claude profile is invalid. Repair it before switching accounts.");
        }
        files.unshift({
          path: profilePath,
          before: profile,
          after: JSON.stringify({ ...existing, oauthAccount: {
            accountUuid: account.accountUuid ?? null,
            emailAddress: account.email,
          } }),
        });
      }
      await replaceLoginFiles(files);
      localUsageKey(account.provider, after);
    });
    changed();
    return null;
  }

  bb.rpc.register(rpcContract, {
    overview: async () => {
      for (const id of ["claude", "codex", "grok"] as const) history.refresh(id).catch(logBackground);
      const swap = await Promise.all(
        STACK_IDS.map(async (id) => {
          const login = fileLoginFor(id);
          const state = await serialized(async () => {
            const loaded = await loadPool(id);
            if (await syncActive(login, loaded)) await bb.storage.kv.set(`pool:${id}`, loaded);
            return loaded;
          });
          const live = await readLiveRaw(login);
          const profile = await readProfile(login);
          const captured = live ? login.capture(live, profile) : null;
          let key: string | null = null;
          let email: string | null = null;
          if (captured) {
            try {
              const identity = login.identify(captured);
              key = identity.key;
              email = identity.email;
            } catch {
              // not a usable login
            }
          }
          const savedMeta = key ? Object.values(state.accounts).find((meta) => meta.key === key) : undefined;
          const binary = isSwapId(id) ? SWAP_PROVIDERS[id].login.binary : id;
          return {
            id,
            label: login.label,
            installed: (await findBinary(binary)) !== null,
            active: state.active,
            accounts: state.order.map((name) => {
              const meta = state.accounts[name];
              return {
                name,
                email: meta.email,
                active: state.active === name,
                exhaustedUntil: meta.exhaustedUntil,
                lastError: meta.lastError,
                lastActivatedAt: meta.lastActivatedAt,
                addedAt: meta.addedAt,
                usage: (() => {
                  refreshUsage(id, name).catch(logBackground);
                  return usage.get(usageKey(id, name));
                })(),
              };
            }),
            live: {
              email: email ?? savedMeta?.email ?? null,
              saved: Boolean(savedMeta),
              signedIn: key !== null,
            },
          };
        }),
      );
      const view = await pool.view();
      return {
        now: Date.now(),
        autoSwitch: (await settings.get()).autoSwitch,
        swap,
        pool: {
          installed: view.installed,
          enabled: view.enabled,
          routing: view.routing,
          accounts: view.accounts.map(toPoolAccount),
          error: view.error,
          localLogin: await localLogins(view.accounts),
        },
        login,
        history: {
          claude: history.get("claude"),
          codex: history.get("codex"),
          grok: history.get("grok"),
        },
      };
    },
    setAutoSwitch: async ({ enabled }) => {
      await settings.experimental_set({ autoSwitch: enabled });
      return null;
    },
    use: async ({ provider, name }) => {
      await useAccount(fileLoginFor(provider), name);
      return null;
    },
    markUsed: async ({ provider, name }) => {
      await markUsed(fileLoginFor(provider), name);
      return null;
    },
    reset: async ({ provider, name }) => {
      await resetAccounts(fileLoginFor(provider), [name]);
      return null;
    },
    remove: async ({ provider, name }) => {
      await removeAccount(fileLoginFor(provider), name);
      return null;
    },
    move: async ({ provider, name, direction }) => {
      await moveAccount(fileLoginFor(provider), name, direction);
      return null;
    },
    saveCurrent: async ({ provider }) => ({
      name: await saveCurrent(fileLoginFor(provider)),
    }),
    loginStart: async ({ provider, name }) => startLogin(provider, name),
    loginSubmit: async ({ code }) => submitLogin(code),
    loginCancel: async () => {
      const kept = !swapLogin?.committed;
      stopLogins();
      login = null;
      changed();
      return { kept };
    },
    poolEnable: async () => {
      throw new Error(POOLER_STAYS_OFF);
    },
    poolImport: async ({ provider }) => {
      await saveCurrent(fileLoginFor(provider));
      changed();
      return null;
    },
    poolUse: async ({ id }) => usePoolAccount(id),
    poolRemove: async ({ id }) => {
      await pool.remove(id);
      changed();
      return null;
    },
    poolToggle: async ({ id, enabled }) => {
      await pool.setEnabled(id, enabled);
      changed();
      return null;
    },
    poolMove: async ({ provider, id, direction }) => {
      const view = await pool.view();
      const ids = view.accounts.filter((a) => a.provider === provider).map((a) => a.id);
      await pool.reorder(provider, moveInOrder(ids, id, direction));
      changed();
      return null;
    },
    poolRouting: async ({ provider, enabled }) => {
      await pool.setRouting(provider, enabled);
      changed();
      return null;
    },
    poolRefresh: async ({ id }) => {
      await pool.refresh(id);
      const account = (await pool.view()).accounts.find((a) => a.id === id);
      if (
        account?.enabled &&
        account.error &&
        /OAuth refresh failed with HTTP (400|401)\b/.test(account.error)
      ) {
        await reconnectPoolAccount(account);
      }
      changed();
      return null;
    },
    usageRefresh: async ({ provider, name }) => {
      const state = await loadPool(provider);
      requireAccount(state, name);
      await refreshUsage(provider, name, true);
      return null;
    },
    localUsageRefresh: async ({ provider }) => {
      const body = await readOptional(
        path.join(os.homedir(), provider === "claude" ? ".claude/.credentials.json" : ".codex/auth.json"),
      );
      const local = provider === "claude" ? readClaudeLocal(body, null) : readCodexLocal(body);
      const key = localUsageKey(provider, local ? body : null);
      if (!local || !key || !body) throw new Error("This machine is not signed in. Add an account.");
      await usage.refresh(
        key,
        () => fetchLocalUsage(provider, body, localCredentialStore(provider)),
        true,
      );
      return null;
    },
    historyRefresh: async ({ provider }) => {
      await history.refresh(provider, true);
      return null;
    },
  });

  // ── CLI ──────────────────────────────────────────────────────────────────

  const stackList = STACK_IDS.join("|");
  bb.cli.register({
    name: "subs",
    summary: "Stack logins per AI subscription and switch when one runs out of quota",
    commands: [
      {
        name: "list",
        summary: "Show saved accounts and their quota state",
        usage: "bb subs list [<provider>] [--json]",
      },
      {
        name: "quota",
        summary: "Show saved accounts' current plan and model quota remaining; unknown data stays unknown",
        usage: "bb subs quota [<provider>] [--refresh] [--json]",
      },
      {
        name: "add",
        summary: "Save the login a CLI is using now (or a login file)",
        usage: `bb subs add <${stackList}> [<name>] [--from <file>] [--force]`,
      },
      {
        name: "use",
        summary: "Switch a provider to a saved account now",
        usage: `bb subs use <${stackList}> <name>`,
      },
      {
        name: "next",
        summary: "Mark the active account used up and switch to the next one",
        usage: `bb subs next <${stackList}>`,
      },
      {
        name: "reset",
        summary: "Clear out-of-quota marks",
        usage: `bb subs reset <${stackList}> [<name>]`,
      },
      {
        name: "remove",
        summary: "Forget an account",
        usage: `bb subs remove <${stackList}> <name>`,
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const force = argv.includes("--force");
      const fromIndex = argv.indexOf("--from");
      const from = fromIndex >= 0 ? argv[fromIndex + 1] : undefined;
      const positional = argv.filter(
        (arg, index) => !arg.startsWith("--") && !(fromIndex >= 0 && index === fromIndex + 1),
      );
      const [subcommand = "list", rawProvider, rawName] = positional;
      const provider = (): FileLogin => {
        const parsed = stackIdSchema.safeParse(rawProvider);
        if (!parsed.success) throw new Error(`Provider must be one of ${stackList}.`);
        return fileLoginFor(parsed.data);
      };

      try {
        switch (subcommand) {
          case "quota": {
            const unknownOption = argv.find((arg) => arg.startsWith("--") && arg !== "--json" && arg !== "--refresh");
            if (unknownOption || rawName) throw new Error("Usage: bb subs quota [<provider>] [--refresh] [--json]");
            const chosen = rawProvider ? stackIdSchema.safeParse(rawProvider) : null;
            if (chosen && !chosen.success) throw new Error(`Provider must be one of ${stackList}.`);
            const ids = chosen?.success ? [chosen.data] : STACK_IDS;
            const accounts: QuotaAccount[] = [];
            for (const id of ids) {
              const state = await loadPool(id);
              for (const name of state.order) {
                await refreshUsage(id, name, argv.includes("--refresh"));
                const meta = state.accounts[name];
                accounts.push(quotaAccount({ provider: id, account: name, email: meta.email, active: state.active === name }, usage.get(usageKey(id, name)), Date.now()));
              }
            }
            const report: QuotaReport = { now: Date.now(), accounts };
            return done(json ? JSON.stringify(report, null, 2) : renderQuotas(report));
          }
          case "list": {
            const chosen = rawProvider ? stackIdSchema.safeParse(rawProvider) : null;
            if (chosen && !chosen.success) throw new Error(`Provider must be one of ${stackList}.`);
            const ids = chosen?.success ? [chosen.data] : STACK_IDS;
            const states = await Promise.all(ids.map(async (id) => [id, await loadPool(id)] as const));
            const view = await pool.view();
            if (json) {
              return done(
                JSON.stringify(
                  {
                    swap: Object.fromEntries(
                      states.map(([id, s]) => [
                        id,
                        {
                          active: s.active,
                          accounts: s.order.map((n) => s.accounts[n]),
                        },
                      ]),
                    ),
                    pool: {
                      enabled: view.enabled,
                      accounts: view.accounts.map(toPoolAccount),
                    },
                  },
                  null,
                  2,
                ),
              );
            }
            const sections = states.map(([id, s]) => renderList(fileLoginFor(id).label, s));
            return done(sections.join("\n\n"));
          }
          case "add": {
            const spec = provider();
            const raw = from ? await fs.readFile(from, "utf8") : null;
            const name = raw
              ? await addAccount(spec, rawName, spec.capture(raw, null) ?? raw, { force })
              : await saveCurrent(spec, rawName, force);
            return done(`Saved ${spec.label} account ${name}.`);
          }
          case "use": {
            const meta = await useAccount(provider(), rawName ?? "");
            return done(`Now using ${meta.name}${meta.email ? ` (${meta.email})` : ""}.`);
          }
          case "next": {
            const spec = provider();
            const state = await loadPool(spec.id);
            if (!state.active) return done("No active account.");
            const next = await markUsed(spec, state.active);
            return done(
              next && next !== state.active ? `Switched to ${next}.` : "No other account has quota left.",
            );
          }
          case "reset": {
            const names = await resetAccounts(provider(), rawName ? [rawName] : null);
            return done(`Cleared quota marks on ${names.join(", ") || "no accounts"}.`);
          }
          case "remove": {
            await removeAccount(provider(), rawName ?? "");
            return done(`Removed ${rawName}. The live login was left as it is.`);
          }
          default:
            return {
              exitCode: 2,
              stderr: `Unknown subcommand "${subcommand}".\nUsage: bb subs <list|quota|add|use|next|reset|remove>\n`,
            };
        }
      } catch (error) {
        return { exitCode: 1, stderr: `${(error as Error).message}\n` };
      }
    },
  });

  bb.onDispose(() => stopLogins());
}

async function restrictToOwner(dbPath: string): Promise<void> {
  await fs.chmod(path.dirname(dbPath), 0o700).catch(() => undefined);
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    await fs.chmod(file, 0o600).catch(() => undefined);
  }
}

function stagingRoot(): string {
  return path.join(os.homedir(), ".cache", "bb-subscription-accounts");
}

function renderList(label: string, state: PoolState): string {
  if (state.order.length === 0) return `${label}\n  (no accounts)`;
  const now = Date.now();
  const rows = state.order.map((name) => {
    const meta = state.accounts[name];
    const marker = state.active === name ? "*" : " ";
    const status = isUsable(meta, now)
      ? "ready"
      : `out of quota, resets in ${formatDuration(meta.exhaustedUntil - now)}`;
    return `${marker} ${name.padEnd(18)} ${(meta.email ?? "").padEnd(32)} ${status}`;
  });
  return [label, ...rows].join("\n");
}

function done(stdout: string): { exitCode: number; stdout: string } {
  return {
    exitCode: 0,
    stdout: stdout.endsWith("\n") ? stdout : `${stdout}\n`,
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export type { PoolProviderId };
