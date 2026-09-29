// bb-plugin-subscription-accounts — stack several logins per AI subscription
// and move to the next one when an account runs out of quota.
//
// Antigravity, Cursor and Grok keep their login in one file under HOME. This
// plugin saves copies of that file per account and swaps them in; a stopped
// thread starts its next turn with a fresh CLI process that reads the new file.
// Claude Code and Codex go through bb's builtin Account Pooler (pooler.ts),
// which routes their traffic by quota without swapping files.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { LoginSession, type LoginState, findBinary, stripAnsi } from "./login.js";
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
import { type PoolAccount, pooler } from "./pooler.js";
import { UsageCache, usageSchema, UsageError } from "./usage.js";
import { createLocalUsageClient, createUsageClient } from "./usage-client.js";
import { HistoryCache } from "./history.js";
import { PricingStore } from "./pricing.js";
import { historySchema } from "./history-schema.js";
import {
  type PoolProviderId,
  SWAP_IDS,
  SWAP_PROVIDERS,
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

const swapIdSchema = z.enum(["antigravity", "cursor", "grok"]);
const poolIdSchema = z.enum(["claude", "codex"]);
const anyProviderSchema = z.enum(["antigravity", "cursor", "grok", "claude", "codex"]);

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
});

const localLoginSchema = z.object({
  email: z.string().nullable(),
  plan: z.string().nullable(),
  inStack: z.boolean(),
  usage: usageSchema,
});

const overviewSchema = z.object({
  now: z.number(),
  autoSwitch: z.boolean(),
  swap: z.array(
    z.object({
      id: swapIdSchema,
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

const swapTarget = z.object({ provider: swapIdSchema, name: z.string() });
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
    input: z.object({ provider: swapIdSchema }),
    output: z.object({ name: z.string() }),
  },
  loginStart: {
    input: z.object({ provider: anyProviderSchema }),
    output: loginSchema,
  },
  loginSubmit: { input: z.object({ code: z.string() }), output: loginSchema },
  loginCancel: { input: z.null(), output: ok },
  poolEnable: { input: z.null(), output: ok },
  poolImport: { input: z.object({ provider: poolIdSchema }), output: ok },
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
  const usage = new UsageCache(() => changed());
  const history = new HistoryCache(
    () => changed(),
    undefined,
    undefined,
    undefined,
    () => pricing.current(),
  );
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
  const usageKey = (provider: SwapProviderId, name: string) => `${provider}/${name}`;
  bb.onDispose(() => {
    usage.dispose();
    history.dispose();
    usageController.abort();
  });
  const settings = bb.settings.define({
    autoSwitch: {
      type: "boolean",
      label: "Switch accounts automatically",
      default: true,
      description:
        "When an Antigravity, Cursor or Grok turn fails on a quota limit, mark the account as used up, " +
        "switch to the next saved account, and retry the turn. Claude and Codex are switched by the Account Pooler.",
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
  ]);
  // The database holds refresh tokens; keep it owner-only like the CLIs' own files.
  await restrictToOwner(db.name);

  const pool = pooler(bb);

  function changed(): void {
    bb.realtime.publish(CHANGED, null);
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

  const livePath = (provider: SwapProvider) => path.join(os.homedir(), provider.tokenPath);

  async function loadPool(id: SwapProviderId): Promise<PoolState> {
    const stored = await bb.storage.kv.get<PoolState>(`pool:${id}`);
    const state = { ...emptyPool(), ...stored };
    // Drop names without a saved account so one bad write cannot wedge a list.
    state.order = state.order.filter((name) => state.accounts[name]);
    if (state.active && !state.accounts[state.active]) state.active = null;
    return state;
  }

  async function savePool(id: SwapProviderId, state: PoolState): Promise<void> {
    await bb.storage.kv.set(`pool:${id}`, state);
    changed();
  }

  function mutate<T>(id: SwapProviderId, change: (state: PoolState) => Promise<T>): Promise<T> {
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

  function readToken(provider: SwapProviderId, name: string): string | null {
    const row = db.prepare("SELECT body FROM tokens WHERE provider = ? AND name = ?").get(provider, name) as
      { body: string } | undefined;
    return row?.body ?? null;
  }

  function writeToken(provider: SwapProviderId, name: string, body: string): void {
    db.prepare(
      "INSERT INTO tokens (provider, name, body, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(provider, name) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at",
    ).run(provider, name, body, Date.now());
  }

  function deleteToken(provider: SwapProviderId, name: string): void {
    db.prepare("DELETE FROM tokens WHERE provider = ? AND name = ?").run(provider, name);
  }

  async function readLive(provider: SwapProvider): Promise<string | null> {
    try {
      return await fs.readFile(livePath(provider), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  function liveKey(provider: SwapProvider, body: string | null): string | null {
    if (!body) return null;
    try {
      return provider.identify(body).key;
    } catch {
      return null;
    }
  }

  /** Atomic replace so a CLI starting mid-swap never reads half a login. */
  async function writeLive(provider: SwapProvider, body: string): Promise<void> {
    const target = livePath(provider);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.swap`;
    await fs.writeFile(temp, body, { mode: 0o600 });
    await fs.rename(temp, target);
  }

  /** The CLIs refresh their tokens in place; copy that back into the active slot. */
  async function syncActive(provider: SwapProvider, state: PoolState): Promise<boolean> {
    if (!state.active) return false;
    const meta = state.accounts[state.active];
    const live = await readLive(provider);
    if (!meta || !live) return false;
    if (liveKey(provider, live) !== meta.key) return false;
    if (readToken(provider.id, state.active) === live) return false;
    writeToken(provider.id, state.active, live);
    return true;
  }

  async function activate(provider: SwapProvider, state: PoolState, name: string): Promise<void> {
    const body = readToken(provider.id, name);
    if (!body) throw new Error(`No saved login for "${name}". Add it again.`);
    await syncActive(provider, state);
    await writeLive(provider, body);
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
    provider: SwapProvider,
    rawName: string | undefined,
    body: string,
    options: { force?: boolean; makeActive?: boolean; home?: string } = {},
  ): Promise<string> {
    const identity = provider.identify(body);
    const email = identity.email ?? (await whoami(provider, options.home));
    return mutate(provider.id, async (state) => {
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
      writeToken(provider.id, name, body);
      usage.remove(usageKey(provider.id, name));
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

  async function saveCurrent(provider: SwapProvider, rawName?: string, force = false): Promise<string> {
    const body = await readLive(provider);
    if (!body) throw new Error(`${provider.label} is not signed in on this machine.`);
    return addAccount(provider, rawName, body, { force, makeActive: true });
  }

  const useAccount = (provider: SwapProvider, raw: string) =>
    mutate(provider.id, async (state) => {
      const meta = requireAccount(state, raw);
      await activate(provider, state, meta.name);
      return meta;
    });

  const markUsed = (provider: SwapProvider, raw: string) =>
    mutate(provider.id, async (state) => {
      const meta = requireAccount(state, raw);
      meta.exhaustedUntil = Date.now() + (await fallbackCooldownMs());
      if (state.active !== meta.name) return null;
      const next = nextUsable(state, Date.now());
      if (next && next !== meta.name) await activate(provider, state, next);
      return next;
    });

  const resetAccounts = (provider: SwapProvider, names: string[] | null) =>
    mutate(provider.id, async (state) => {
      const targets = names ?? state.order;
      for (const name of targets) {
        const meta = requireAccount(state, name);
        meta.exhaustedUntil = 0;
        meta.lastError = null;
      }
      return targets;
    });

  const removeAccount = (provider: SwapProvider, raw: string) =>
    mutate(provider.id, async (state) => {
      const meta = requireAccount(state, raw);
      delete state.accounts[meta.name];
      state.order = state.order.filter((n) => n !== meta.name);
      deleteToken(provider.id, meta.name);
      usage.remove(usageKey(provider.id, meta.name));
      if (state.active === meta.name) state.active = null;
    });

  const moveAccount = (provider: SwapProvider, raw: string, direction: "up" | "down") =>
    mutate(provider.id, async (state) => {
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
    const provider = swapProviderForThread(thread.providerId);
    if (!provider) return;
    const error = await latestProviderError(event.threadId);
    if (!error || !provider.quota.test(error)) return;

    await serialized(async () => {
      const state = await loadPool(provider.id);
      if (state.order.length === 0) return;
      if (event.attemptNumber > state.order.length + 1) {
        bb.log.warn(`${event.threadId}: giving up after ${event.attemptNumber} attempts`);
        return;
      }

      const now = Date.now();
      const onOldAccount = event.attemptNumber === 1 && now - state.lastSwitchAt < SWITCH_GRACE_MS;
      if (!onOldAccount) {
        const meta = state.active ? state.accounts[state.active] : undefined;
        if (meta) {
          const resetMs = parseResetMs(error) ?? (await fallbackCooldownMs());
          meta.exhaustedUntil = now + resetMs;
          meta.lastError = error.slice(0, 300);
          bb.log.info(`${provider.id}/${meta.name} out of quota for ${formatDuration(resetMs)}`);
        }
        const next = nextUsable(state, now);
        if (next && next !== state.active) {
          const from = state.active;
          await activate(provider, state, next);
          bb.log.info(`${provider.id}: switched ${from ?? "(none)"} -> ${next}`);
        } else if (!next) {
          const soonest = earliestReset(state);
          await savePool(provider.id, state);
          if (!soonest) return;
          await restartAndRetry(
            event.threadId,
            event.requestId,
            `All ${provider.label} accounts are out of quota. Retrying when ${soonest.name} resets.`,
            soonest.at + RETRY_SLACK_MS,
          );
          return;
        }
      }
      await savePool(provider.id, state);
      await restartAndRetry(
        event.threadId,
        event.requestId,
        `${provider.label} quota reached. Continuing on ${state.active}.`,
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
        for (const id of SWAP_IDS) {
          const provider = SWAP_PROVIDERS[id];
          try {
            await serialized(async () => {
              const state = await loadPool(id);
              let dirty = await syncActive(provider, state);
              const now = Date.now();
              const active = state.active ? state.accounts[state.active] : undefined;
              if (active && !isUsable(active, now)) {
                const next = nextUsable(state, now);
                if (next && next !== state.active) {
                  await activate(provider, state, next);
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

  async function startLogin(provider: z.infer<typeof anyProviderSchema>): Promise<LoginState> {
    stopLogins();
    if (isSwapId(provider)) {
      const spec = SWAP_PROVIDERS[provider];
      const binary = await findBinary(spec.login.binary);
      if (!binary) throw new Error(`${spec.login.binary} is not installed on this machine.`);
      const home = path.join(stagingRoot(), `${provider}-${Date.now()}`);
      const session = new LoginSession(
        provider,
        spec.login,
        home,
        spec.tokenPath,
        () => {
          if (swapLogin === session) {
            login = { ...session.state };
            changed();
          }
        },
        async (tokenFile, sessionHome) =>
          addAccount(spec, undefined, await fs.readFile(tokenFile, "utf8"), {
            makeActive: true,
            home: sessionHome,
          }),
      );
      swapLogin = session;
      login = { ...session.state };
      await session.start(binary);
      return login;
    }

    await ensurePooler();
    if (provider === "claude") {
      const started = await pool.claudeLoginStart();
      claudeSessionId = started.sessionId;
      return loginState("claude", {
        status: "waiting",
        url: started.authorizeUrl,
        needsCode: true,
        expiresAt: Date.now() + 10 * 60_000,
      });
    }

    const started = await pool.codexLoginStart();
    const state = loginState("codex", {
      status: "waiting",
      url: started.verificationUri,
      userCode: started.userCode,
      expiresAt: started.expiresAt,
    });
    const poll = async () => {
      if (!codexPoll || codexPoll.sessionId !== started.sessionId) return;
      try {
        const result = await pool.codexLoginPoll(started.sessionId);
        if (result.status === "complete") {
          codexPoll = null;
          updateLogin({
            status: "done",
            account: result.account.email ?? result.account.label,
          });
          return;
        }
        if (result.status === "error") {
          codexPoll = null;
          updateLogin({ status: "failed", error: result.message });
          return;
        }
      } catch (error) {
        codexPoll = null;
        updateLogin({ status: "failed", error: (error as Error).message });
        return;
      }
      codexPoll.timer = setTimeout(poll, started.intervalMs);
    };
    codexPoll = {
      sessionId: started.sessionId,
      timer: setTimeout(poll, started.intervalMs),
    };
    return state;
  }

  async function submitLogin(code: string): Promise<LoginState> {
    if (!login) throw new Error("No sign-in in progress. Start again.");
    if (login.provider === "claude") {
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

  async function ensurePooler(): Promise<void> {
    const view = await pool.view();
    if (!view.installed) throw new Error("bb's Account Pooler plugin is not available in this bb.");
    if (!view.enabled) await pool.enable();
  }

  // ── page RPC ─────────────────────────────────────────────────────────────

  function refreshUsage(provider: SwapProviderId, name: string, force = false) {
    return usage.refresh(
      usageKey(provider, name),
      async () => {
        let body: string | null = null;
        await serialized(async () => {
          const state = await loadPool(provider);
          requireAccount(state, name);
          await syncActive(SWAP_PROVIDERS[provider], state);
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
            if (state.active === name && (await readLive(SWAP_PROVIDERS[provider])) === expectedBody) {
              await writeLive(SWAP_PROVIDERS[provider], updated);
            }
            writeToken(provider, name, updated);
            expectedBody = updated;
          });
        });
      },
      force,
    );
  }

  function toPoolAccount(account: PoolAccount): z.infer<typeof poolAccountSchema> {
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
    };
  }

  async function readOptional(file: string): Promise<string | null> {
    return fs.readFile(file, "utf8").catch(() => null);
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
    const mark = (provider: PoolProviderId, local: LocalLogin | null, body: string | null) => {
      if (!local || !body) {
        localUsageKey(provider, null);
        return null;
      }
      const key = localUsageKey(provider, body)!;
      void usage.refresh(key, () => fetchLocalUsage(provider, body));
      return {
        ...local,
        inStack: accounts.some(
          (a) =>
            a.provider === provider &&
            local.email !== null &&
            a.email?.toLowerCase() === local.email.toLowerCase(),
        ),
        usage: usage.get(key),
      };
    };
    return {
      claude: mark("claude", readClaudeLocal(claudeCreds, claudeProfile), claudeCreds),
      codex: mark("codex", readCodexLocal(codexAuth), codexAuth),
    };
  }

  bb.rpc.register(rpcContract, {
    overview: async () => {
      for (const id of ["claude", "codex", "grok"] as const) void history.refresh(id);
      const swap = await Promise.all(
        SWAP_IDS.map(async (id) => {
          const provider = SWAP_PROVIDERS[id];
          const state = await serialized(async () => {
            const loaded = await loadPool(id);
            if (await syncActive(provider, loaded)) await bb.storage.kv.set(`pool:${id}`, loaded);
            return loaded;
          });
          const live = await readLive(provider);
          const key = liveKey(provider, live);
          const savedMeta = Object.values(state.accounts).find((meta) => meta.key === key);
          let email: string | null = null;
          if (live) {
            try {
              email = provider.identify(live).email;
            } catch {
              // not a usable login
            }
          }
          return {
            id,
            label: provider.label,
            installed: (await findBinary(provider.login.binary)) !== null,
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
                  void refreshUsage(id, name);
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
      await useAccount(SWAP_PROVIDERS[provider], name);
      return null;
    },
    markUsed: async ({ provider, name }) => {
      await markUsed(SWAP_PROVIDERS[provider], name);
      return null;
    },
    reset: async ({ provider, name }) => {
      await resetAccounts(SWAP_PROVIDERS[provider], [name]);
      return null;
    },
    remove: async ({ provider, name }) => {
      await removeAccount(SWAP_PROVIDERS[provider], name);
      return null;
    },
    move: async ({ provider, name, direction }) => {
      await moveAccount(SWAP_PROVIDERS[provider], name, direction);
      return null;
    },
    saveCurrent: async ({ provider }) => ({
      name: await saveCurrent(SWAP_PROVIDERS[provider]),
    }),
    loginStart: async ({ provider }) => startLogin(provider),
    loginSubmit: async ({ code }) => submitLogin(code),
    loginCancel: async () => {
      stopLogins();
      login = null;
      changed();
      return null;
    },
    poolEnable: async () => {
      await ensurePooler();
      changed();
      return null;
    },
    poolImport: async ({ provider }) => {
      await ensurePooler();
      const view = await pool.view();
      const last = view.accounts.filter((a) => a.provider === provider).map((a) => a.priority);
      await pool.importLocal(provider, last.length ? Math.max(...last) + 1 : 0);
      changed();
      return null;
    },
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
      await usage.refresh(key, () => fetchLocalUsage(provider, body), true);
      return null;
    },
    historyRefresh: async ({ provider }) => {
      await history.refresh(provider, true);
      return null;
    },
  });

  // ── CLI ──────────────────────────────────────────────────────────────────

  const swapList = SWAP_IDS.join("|");
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
        name: "add",
        summary: "Save the login a CLI is using now (or a login file)",
        usage: `bb subs add <${swapList}> [<name>] [--from <file>] [--force]`,
      },
      {
        name: "use",
        summary: "Switch a provider to an account now",
        usage: `bb subs use <${swapList}> <name>`,
      },
      {
        name: "next",
        summary: "Mark the active account used up and switch to the next one",
        usage: `bb subs next <${swapList}>`,
      },
      {
        name: "reset",
        summary: "Clear out-of-quota marks",
        usage: `bb subs reset <${swapList}> [<name>]`,
      },
      {
        name: "remove",
        summary: "Forget an account",
        usage: `bb subs remove <${swapList}> <name>`,
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
      const provider = (): SwapProvider => {
        if (rawProvider === "claude" || rawProvider === "codex") {
          throw new Error(
            `${rawProvider} accounts are managed by the Account Pooler: use the Subscription Accounts page or \`bb pool\`.`,
          );
        }
        if (!rawProvider || !isSwapId(rawProvider)) throw new Error(`Provider must be one of ${swapList}.`);
        return SWAP_PROVIDERS[rawProvider];
      };

      try {
        switch (subcommand) {
          case "list": {
            const ids = rawProvider && isSwapId(rawProvider) ? [rawProvider] : SWAP_IDS;
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
            const sections = states.map(([id, s]) => renderList(SWAP_PROVIDERS[id].label, s));
            if (!rawProvider || rawProvider === "claude" || rawProvider === "codex") {
              sections.push(renderPool(view.enabled, view.accounts));
            }
            return done(sections.join("\n\n"));
          }
          case "add": {
            const spec = provider();
            const name = from
              ? await addAccount(spec, rawName, await fs.readFile(from, "utf8"), { force })
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
              stderr: `Unknown subcommand "${subcommand}".\nUsage: bb subs <list|add|use|next|reset|remove>\n`,
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

function renderPool(enabled: boolean, accounts: PoolAccount[]): string {
  if (!enabled)
    return "Claude / Codex\n  Account Pooler is off. Turn it on from the Subscription Accounts page.";
  if (accounts.length === 0) return "Claude / Codex\n  (no accounts)";
  const rows = accounts.map(
    (a) => `  ${a.provider.padEnd(7)} ${(a.email ?? a.label).padEnd(32)} ${a.status}`,
  );
  return ["Claude / Codex (Account Pooler)", ...rows].join("\n");
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
