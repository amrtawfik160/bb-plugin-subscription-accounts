// Subscription Accounts page: one tab per AI subscription. Each provider swaps
// its saved login file when quota runs out. Claude and Codex sign in through
// their own CLIs, then this page saves that login.
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";

import type { rpcContract } from "./server";
import {
  USAGE_TTL_MS,
  quotaPace,
  type AccountUsage,
  type UsageMetric,
  type UsageHistory,
} from "./usage-types";
import { HistoryPanel, ProviderLinks } from "./usage-history";
import { AllUsage } from "./all-usage-panel";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { usePortalScopeProps } from "@/lib/portal-scope";

type SwapId = "antigravity" | "cursor" | "grok";
type PoolId = "claude" | "codex";
type ProviderId = SwapId | PoolId;
type TabId = ProviderId | "all";

interface SwapAccount {
  name: string;
  email: string | null;
  active: boolean;
  exhaustedUntil: number;
  lastError: string | null;
  usage: AccountUsage;
}
interface SwapSection {
  id: ProviderId;
  label: string;
  installed: boolean;
  active: string | null;
  accounts: SwapAccount[];
  live: { email: string | null; saved: boolean; signedIn: boolean };
}
interface PoolAccount {
  id: string;
  provider: PoolId;
  label: string;
  email: string | null;
  subscriptionType: string | null;
  enabled: boolean;
  status: "disabled" | "ready" | "held" | "exhausted" | "error";
  fiveHourUtilization: number | null;
  fiveHourResetAt: number | null;
  sevenDayUtilization: number | null;
  sevenDayResetAt: number | null;
  heldUntil: number | null;
  error: string | null;
  quotaMetrics?: UsageMetric[];
  canUseMachine?: boolean;
}
interface Login {
  id: string;
  provider: string;
  targetAccount: string | null;
  status: "starting" | "waiting" | "verifying" | "done" | "failed";
  url: string | null;
  userCode: string | null;
  needsCode: boolean;
  expiresAt: number | null;
  error: string | null;
  account: string | null;
}
export interface Overview {
  now: number;
  autoSwitch: boolean;
  swap: SwapSection[];
  pool: {
    installed: boolean;
    enabled: boolean;
    routing: Record<PoolId, boolean>;
    accounts: PoolAccount[];
    error: string | null;
    localLogin: Record<
      PoolId,
      {
        email: string | null;
        plan: string | null;
        inStack: boolean;
        stackAccountId?: string | null;
        usage: AccountUsage;
      } | null
    >;
  };
  login: Login | null;
  history?: Record<"claude" | "codex" | "grok", UsageHistory>;
}

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type Run = (task: () => Promise<unknown>, done?: string) => Promise<void>;

const CHANGED = "accounts-changed";
const TABS: { id: TabId; label: string }[] = [
  { id: "all", label: "All" },
  { id: "antigravity", label: "Antigravity" },
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
  { id: "cursor", label: "Cursor" },
  { id: "grok", label: "Grok" },
];

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function formatWait(ms: number): string {
  if (ms <= 0) return "now";
  const minutes = Math.ceil(ms / 60_000);
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  if (d > 0) return `${d}d ${h}h`;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Re-render every `ms` while `enabled`, for countdowns. */
function useNow(ms: number, enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms, enabled]);
  return now;
}

function useOverview() {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const refetch = useCallback(() => {
    const currentRequest = ++requestId.current;
    rpc.call("overview").then(
      (next) => {
        if (currentRequest !== requestId.current) return;
        setData(next as Overview);
        setError(null);
      },
      (cause) => {
        if (currentRequest === requestId.current) setError(message(cause));
      },
    );
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime(CHANGED, refetch);
  // Quota marks and pooler usage change on the clock, not on an event.
  useEffect(() => {
    const timer = setInterval(refetch, 30_000);
    return () => clearInterval(timer);
  }, [refetch]);
  const run: Run = useCallback(
    async (task, done) => {
      try {
        await task();
        if (done) toast.success(done);
        refetch();
      } catch (cause) {
        toast.error(message(cause));
      }
    },
    [refetch],
  );
  return { rpc, data, error, run, refetch };
}

// ── shared bits ───────────────────────────────────────────────────────────

function Notice({ tone = "info", children }: { tone?: "info" | "warn"; children: ReactNode }) {
  return (
    <div
      role="status"
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-4 py-3 text-sm",
        tone === "warn" ? "border-destructive/40" : "border-border bg-card",
      )}
    >
      {children}
    </div>
  );
}

function Dot({ tone }: { tone: "good" | "bad" | "idle" | "warn" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-2 shrink-0 rounded-full",
        tone === "good" && "bg-success",
        tone === "bad" && "bg-destructive",
        tone === "warn" && "bg-warning",
        tone === "idle" && "bg-muted-foreground/40",
      )}
    />
  );
}

function OrderArrows({
  name,
  index,
  count,
  onMove,
}: {
  name: string;
  index: number;
  count: number;
  onMove: (direction: "up" | "down") => void;
}) {
  return (
    <div className="flex flex-col items-center text-muted-foreground">
      <button
        type="button"
        aria-label={`Move ${name} up`}
        disabled={index === 0}
        className="rounded p-0.5 hover:text-foreground disabled:opacity-30"
        onClick={() => onMove("up")}
      >
        <Icon name="ChevronUp" className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label={`Move ${name} down`}
        disabled={index === count - 1}
        className="rounded p-0.5 hover:text-foreground disabled:opacity-30"
        onClick={() => onMove("down")}
      >
        <Icon name="ChevronDown" className="size-3.5" />
      </button>
    </div>
  );
}

function RemoveButton({ name, onRemove }: { name: string; onRemove: () => void }) {
  const [confirming, setConfirming] = useState(false);
  if (confirming) {
    return (
      <span className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground">Remove?</span>
        <Button size="sm" variant="destructive" onClick={onRemove}>
          Remove
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
          Keep
        </Button>
      </span>
    );
  }
  return (
    <Button
      size="icon"
      variant="ghost"
      className="size-8 text-muted-foreground hover:text-foreground"
      aria-label={`Remove ${name}`}
      onClick={() => setConfirming(true)}
    >
      <Icon name="Trash2" className="size-4" />
    </Button>
  );
}

function AccountList({ empty, children }: { empty: string; children: ReactNode[] }) {
  if (children.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
        {empty}
      </div>
    );
  }
  return <ul className="divide-y divide-border rounded-lg border border-border bg-card px-4">{children}</ul>;
}

function formatAmount(value: number, unit: UsageMetric["unit"]): string {
  if (unit === "usd")
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "USD",
    }).format(value);
  if (unit === "percent") return `${Math.round(value)}%`;
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)} ${unit}`;
}

function isHistoricalUsage(usage: AccountUsage, now: number): boolean {
  return usage.status !== "ready" || usage.fetchedAt === null || now - usage.fetchedAt >= USAGE_TTL_MS;
}

function isLoginExpired(usage: AccountUsage): boolean {
  return Boolean(usage.error && /sign in again|login expired|session expired|access expired/i.test(usage.error));
}

function QuotaMeter({ row, now, historical = false }: { row: UsageMetric; now: number; historical?: boolean }) {
  const percent = row.used !== null && row.limit !== null ? (row.used / row.limit) * 100 : null;
  const resetPassed = row.resetAt !== null && row.resetAt <= now;
  const lastReading = historical || resetPassed;
  const pace = lastReading ? null : quotaPace(row, now);
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs">
        <span className="font-medium">{row.label}</span>
        <span className="tabular-nums">
          {row.used !== null
            ? row.unit === "percent"
              ? `${formatAmount(row.used, row.unit)} used`
              : `${formatAmount(row.used, row.unit)}${row.limit !== null ? ` / ${formatAmount(row.limit, row.unit)}` : " used"}`
            : row.remaining !== null
              ? `${formatAmount(row.remaining, row.unit)} left`
              : row.limit !== null
                ? `${formatAmount(row.limit, row.unit)} allowance`
                : "Usage unavailable"}
          {lastReading ? " at last reading" : ""}
        </span>
      </div>
      {percent !== null ? (
        <div
          role="progressbar"
          aria-label={`${row.label} ${lastReading ? "last recorded usage" : "usage"}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.max(0, Math.min(100, percent))}
          aria-valuetext={`${formatAmount(row.used!, row.unit)} used${lastReading ? " at last reading; current allowance unknown" : row.remaining !== null ? `, ${formatAmount(row.remaining, row.unit)} remaining` : ""}`}
          className="relative h-2 overflow-hidden rounded-full bg-muted"
        >
          <div
            className={cn(
              "h-full rounded-full",
              lastReading ? "bg-muted-foreground/50" : percent >= 90 ? "bg-destructive" : percent >= 70 ? "bg-warning" : "bg-success",
            )}
            style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
          />
          {pace ? (
            <span
              aria-hidden
              className="absolute inset-y-0 w-0.5 bg-foreground/60"
              style={{ left: `${pace.expected}%` }}
              title="Expected use at a steady pace"
            />
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {lastReading ? <span>Current allowance unknown</span> : row.used !== null && row.remaining !== null ? (
          <span className="tabular-nums">{formatAmount(row.remaining, row.unit)} left</span>
        ) : null}
        {row.used !== null && row.limit === null ? <span>Quota not reported</span> : null}
        {row.resetAt !== null ? (
          <span title={new Date(row.resetAt).toLocaleString()}>
            {resetPassed ? "Reset passed · refresh usage" : lastReading
              ? `Recorded reset · ${new Date(row.resetAt).toLocaleString()}`
              : `Resets in ${formatWait(row.resetAt - now)}`}
          </span>
        ) : percent !== null ? (
          <span>Reset time not reported</span>
        ) : null}
      </div>
      {pace?.limitIn != null ? (
        <p className="text-xs text-foreground" title="Estimate from average use since the quota window began">
          Limit in ~{formatWait(pace.limitIn)} at this pace
        </p>
      ) : null}
    </div>
  );
}

function UsageDetails({
  usage,
  now,
  onRefresh,
  name,
  showExtraUsage = false,
  actions,
}: {
  usage: AccountUsage;
  now: number;
  onRefresh: () => Promise<unknown>;
  name: string;
  showExtraUsage?: boolean;
  actions?: ReactNode;
}) {
  const [pending, setPending] = useState(false);
  const refresh = async () => {
    setPending(true);
    try {
      await onRefresh();
    } finally {
      setPending(false);
    }
  };
  const stale = isHistoricalUsage(usage, now);
  const loginExpired = Boolean(actions && isLoginExpired(usage));
  const quotaRows = [...usage.metrics.filter((row) => !row.derivedFromModels), ...(usage.modelQuotas ?? [])];
  return (
    <div className="space-y-3 pt-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {usage.refreshing || pending ? (
            "Refreshing usage…"
          ) : usage.fetchedAt !== null ? (
            <span title={new Date(usage.fetchedAt).toLocaleString()}>
              {stale ? "Last known usage" : "Updated"} ·{" "}
              {now - usage.fetchedAt < 60_000 ? "just now" : `${formatWait(now - usage.fetchedAt)} ago`}
            </span>
          ) : (
            "Subscription usage"
          )}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="min-h-11 px-2 text-xs sm:min-h-8"
          disabled={pending || usage.refreshing}
          onClick={() => void refresh()}
          aria-label={`Refresh usage for ${name}`}
        >
          <Icon name="RefreshCw" className="size-3.5" />
          Refresh
        </Button>
      </div>
      {actions}
      {quotaRows.length > 0 ? (
        <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          {quotaRows.map((row) => (
            <QuotaMeter key={row.scope?.kind === "model" ? `model:${row.scope.model}` : row.label} row={row} now={now} historical={stale} />
          ))}
        </div>
      ) : !usage.error ? (
        <p role="status" className="text-xs text-muted-foreground">
          {usage.status === "loading"
            ? "Fetching subscription usage…"
            : usage.status === "unavailable"
              ? "The provider did not report usage for this account. Refresh to check again."
              : "Usage could not be loaded. Refresh to retry."}
        </p>
      ) : null}
      {showExtraUsage &&
      usage.status === "ready" &&
      !usage.metrics.some((row) => row.label === "Extra usage") ? (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium">Extra usage</span> · Not reported
        </p>
      ) : null}
      {usage.error ? (
        <p role="status" className="break-words text-xs text-destructive">
          {loginExpired ? "Login expired. Log in again to load usage." : usage.error}
          {quotaRows.length > 0 ? " Showing the last successful reading." : ""}
        </p>
      ) : null}
      {usage.history ? (
        <HistoryPanel history={usage.history} name={name} now={now} onRefresh={onRefresh} />
      ) : null}
    </div>
  );
}

// ── sign-in ───────────────────────────────────────────────────────────────

function SignIn({
  provider,
  label,
  login,
  rpc,
  run,
  disabled,
  children,
  account,
}: {
  provider: ProviderId;
  label: string;
  login: Login | null;
  rpc: Rpc;
  run: Run;
  disabled?: boolean;
  children?: ReactNode;
  account?: SwapAccount;
}) {
  const [attempt, setAttempt] = useState<
    | { kind: "closed" }
    | { kind: "starting" }
    | { kind: "open"; login: Login }
    | { kind: "failed"; error: string }
    | { kind: "cancelled" }
  >({ kind: "closed" });
  const [code, setCode] = useState("");
  const matches = login?.provider === provider && (login.targetAccount ?? null) === (account?.name ?? null);
  const busy = login && !["done", "failed"].includes(login.status);
  const mine = attempt.kind === "open"
    ? matches && login.id === attempt.login.id ? login : attempt.login
    : matches && busy && attempt.kind === "closed" ? login : null;
  const status = attempt.kind === "starting" ? "starting" : attempt.kind === "failed" ? "failed" : mine?.status ?? null;
  const open = mine !== null || (attempt.kind !== "closed" && attempt.kind !== "cancelled");
  const waiting = status === "waiting";
  const now = useNow(1_000, waiting);
  const left = mine?.expiresAt ? Math.max(0, mine.expiresAt - now) : 0;

  useEffect(() => {
    if (status === "done" && open) {
      toast.success(account ? `Logged in again for ${account.name}` : `Added ${mine?.account ?? "account"}`);
      setAttempt({ kind: "closed" });
      setCode("");
    }
  }, [status, open, mine?.account, account?.name]);

  const start = () => {
    setAttempt({ kind: "starting" });
    setCode("");
    void run(async () => {
      try {
        const next = await rpc.call("loginStart", account ? { provider, name: account.name } : { provider });
        setAttempt({ kind: "open", login: next });
      } catch (cause) {
        setAttempt({ kind: "failed", error: message(cause) });
        throw cause;
      }
    });
  };
  const cancel = () => {
    void run(async () => {
      const result = mine ? await rpc.call("loginCancel") : { kept: true };
      setAttempt(result.kept ? { kind: "cancelled" } : { kind: "closed" });
      setCode("");
    });
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (code.trim()) void run(() => rpc.call("loginSubmit", { code }));
  };

  if (disabled && !open && (provider === "claude" || provider === "codex")) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Install the {label} CLI on the bb server, then refresh this page. {" "}
        <a
          href={provider === "claude" ? "https://code.claude.com/docs/en/setup" : "https://developers.openai.com/codex/cli"}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-11 items-center underline focus-visible:outline-2 focus-visible:outline-ring"
        >
          Set up {label} CLI
        </a>
      </p>
    );
  }

  if (!open || status === "done") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={start}
          disabled={disabled || Boolean(busy)}
          variant={account ? "outline" : "default"}
          size={account ? "sm" : "default"}
          className="min-h-11 sm:min-h-8"
          aria-label={account ? `Log in again for ${account.name}` : undefined}
        >
          <Icon name={account ? "RotateCcw" : "Plus"} className="size-4" />
          {account ? "Log in again" : `Add ${label} account`}
        </Button>
        {attempt.kind === "cancelled" ? <p role="status" className="text-xs text-muted-foreground">Sign-in cancelled. Your saved accounts were kept.</p> : null}
        {children}
      </div>
    );
  }

  return (
    <div className="w-full min-w-0 space-y-4 rounded-lg border border-border bg-card p-4" aria-busy={status === "starting" || status === "verifying"}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="min-w-0 break-words font-medium">{account ? `Log in again for ${account.name}` : `Add a ${label} account`}</h3>
        <Button size="sm" variant="ghost" className="min-h-11 sm:min-h-8" onClick={cancel} disabled={status === "starting"}>
          Cancel
        </Button>
      </div>

      {status === "starting" ? (
        <p role="status" className="text-sm text-muted-foreground">Getting a sign-in link…</p>
      ) : null}

      {status === "failed" ? (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="break-words text-sm text-destructive">{attempt.kind === "failed" ? attempt.error : mine?.error}</p>
          <Button size="sm" className="min-h-11 sm:min-h-8" onClick={start} disabled={Boolean(busy)}>
            Try again
          </Button>
        </div>
      ) : null}

      {mine && (waiting || status === "verifying") ? (
        <ol className="space-y-4 text-sm">
          <li className="space-y-2">
            <p>
              <span className="font-medium">1.</span> Open the sign-in page and sign in with{" "}
              {account ? <span className="break-all font-medium">{account.email ?? account.name}</span> : "the account you want to add"}.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button asChild size="sm" variant="outline" className="min-h-11 sm:min-h-8">
                <a href={mine.url ?? "#"} target="_blank" rel="noreferrer">
                  <Icon name="ExternalLink" className="size-3.5" />
                  Open sign-in page
                </a>
              </Button>
              {mine.userCode ? (
                <span className="text-sm">
                  Confirm this code there:{" "}
                  <code className="rounded bg-muted px-2 py-0.5 font-mono text-base tracking-wider">
                    {mine.userCode}
                  </code>
                </span>
              ) : null}
            </div>
          </li>
          {mine.needsCode ? (
            <li className="space-y-2">
              <p>
                <span className="font-medium">2.</span> Copy the code the page shows and paste it here.
              </p>
              <form onSubmit={submit} className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
                <Input
                  autoFocus
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  placeholder="Authorization code"
                  aria-label="Authorization code"
                  disabled={!waiting}
                  className="min-w-0 flex-1 basis-full font-mono sm:basis-auto"
                />
                <Button type="submit" className="min-h-11 sm:min-h-8" disabled={!waiting || !code.trim()}>
                  {status === "verifying" ? "Signing in…" : account ? "Log in again" : "Add"}
                </Button>
              </form>
            </li>
          ) : (
            <li>
              <p role="status" className="text-muted-foreground">
                {status === "verifying"
                  ? "Saving the login…"
                  : "Waiting for you to finish in the browser. This updates by itself."}
              </p>
            </li>
          )}
          {waiting && mine.expiresAt ? (
            <p className={cn("text-xs", left <= 15_000 ? "text-destructive" : "text-muted-foreground")}>
              {left < 120_000
                ? `The link works for ${Math.ceil(left / 1000)}s more. If time runs out, click Try again.`
                : `The link works for ${formatWait(left)} more.`}
            </p>
          ) : null}
        </ol>
      ) : null}
    </div>
  );
}

// ── Antigravity / Cursor / Grok ───────────────────────────────────────────

function SwapTab({ section, data, rpc, run }: { section: SwapSection; data: Overview; rpc: Rpc; run: Run }) {
  const now = data.now;
  const target = (name: string) => ({ provider: section.id, name });
  const active = section.accounts.find((a) => a.active);
  const ready = section.accounts.filter((a) => a.exhaustedUntil <= now).length;

  return (
    <div className="space-y-5">
      <p className="text-sm">
        {active ? (
          <>
            Using <span className="font-medium">{active.name}</span>
            {active.email ? <span className="text-muted-foreground"> ({active.email})</span> : null}.{" "}
          </>
        ) : (
          "No saved account is active. "
        )}
        <span className="text-muted-foreground">
          {section.accounts.length} saved · {ready} without a cooldown
        </span>
      </p>

      {!section.installed ? (
        <Notice tone="warn">The {section.label} CLI is not installed on the bb server machine.</Notice>
      ) : null}

      {section.live.signedIn && !section.live.saved ? (
        <Notice>
          <span className="flex-1">
            {section.label} is signed in
            {section.live.email ? (
              <>
                {" "}
                as <span className="font-medium">{section.live.email}</span>
              </>
            ) : null}
            , and that login isn't in your list.
          </span>
          <Button
            size="sm"
            onClick={() =>
              run(() => rpc.call("saveCurrent", { provider: section.id }), "Saved the current login")
            }
          >
            Save it
          </Button>
        </Notice>
      ) : null}

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">Accounts, in switching order</h2>
        <AccountList empty={`No ${section.label} accounts yet. Add one below.`}>
          {section.accounts.map((account, index) => {
            const out = account.exhaustedUntil > now;
            const loginExpired = isLoginExpired(account.usage);
            return (
              <li key={account.name} className="space-y-2 py-4">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <OrderArrows
                    name={account.name}
                    index={index}
                    count={section.accounts.length}
                    onMove={(direction) =>
                      run(() =>
                        rpc.call("move", {
                          ...target(account.name),
                          direction,
                        }),
                      )
                    }
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-medium">{account.name}</span>
                      {account.usage.plan ? (
                        <span className="text-xs text-muted-foreground">{account.usage.plan}</span>
                      ) : null}
                      {account.email ? (
                        <span className="truncate text-sm text-muted-foreground">{account.email}</span>
                      ) : null}
                    </div>
                    <span
                      className={cn(
                        "inline-flex items-center gap-1.5 text-xs",
                        out || loginExpired
                          ? "text-destructive"
                          : account.active
                            ? "text-foreground"
                            : "text-muted-foreground",
                      )}
                    >
                      <Dot tone={out || loginExpired ? "bad" : account.active ? "good" : "idle"} />
                      {loginExpired ? (account.active ? "In use · login expired" : "Login expired") : null}
                      {account.active && !loginExpired ? (out ? "In use · out of quota" : "In use") : null}
                      {!account.active && out && !loginExpired
                        ? `Out of quota · back in ${formatWait(account.exhaustedUntil - now)}`
                        : null}
                      {!account.active && !out && !loginExpired ? "Ready" : null}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {out ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          run(() => rpc.call("reset", target(account.name)), `${account.name} marked ready`)
                        }
                      >
                        <Icon name="RotateCcw" className="size-3.5" />
                        Mark ready
                      </Button>
                    ) : account.active ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          run(() => rpc.call("markUsed", target(account.name)), "Moved to the next account")
                        }
                      >
                        Skip to next
                      </Button>
                    ) : null}
                    {!account.active ? (
                      <Button
                        size="sm"
                        onClick={() =>
                          run(() => rpc.call("use", target(account.name)), `Now using ${account.name}`)
                        }
                      >
                        Use now
                      </Button>
                    ) : null}
                    <RemoveButton
                      name={account.name}
                      onRemove={() =>
                        run(() => rpc.call("remove", target(account.name)), `Removed ${account.name}`)
                      }
                    />
                  </div>
                </div>
                <div className="sm:pl-8">
                  <UsageDetails
                    usage={account.usage}
                    now={now}
                    name={account.name}
                    onRefresh={() => run(() => rpc.call("usageRefresh", target(account.name)))}
                    actions={(
                      <SignIn provider={section.id} label={section.label} account={account} login={data.login} rpc={rpc} run={run} disabled={!section.installed} />
                    )}
                  />
                </div>
              </li>
            );
          })}
        </AccountList>
      </section>

      <SignIn
        provider={section.id}
        label={section.label}
        login={data.login}
        rpc={rpc}
        run={run}
        disabled={!section.installed}
      />
    </div>
  );
}

// ── Claude / Codex list from an already-on Account Pooler ─────────────────

function PoolUsage({ account, now }: { account: PoolAccount; now: number }) {
  if (account.quotaMetrics) {
    return account.quotaMetrics.length ? (
      <div className="grid grid-cols-1 gap-x-6 gap-y-4 pt-2 sm:grid-cols-2">
        {account.quotaMetrics.map((row) => (
          <QuotaMeter key={row.label} row={row} now={now} />
        ))}
      </div>
    ) : (
      <p className="text-xs text-muted-foreground">
        Quota unavailable. Refresh to check.
      </p>
    );
  }
  const windows = [
    {
      label: "5-hour window",
      value: account.fiveHourUtilization,
      resetAt: account.fiveHourResetAt,
    },
    {
      label: "Weekly window",
      value: account.sevenDayUtilization,
      resetAt: account.sevenDayResetAt,
    },
  ];
  return (
    <div className="grid grid-cols-1 gap-x-6 gap-y-4 pt-2 sm:grid-cols-2">
      {windows.map(({ label, value, resetAt }) =>
        value === null ? (
          <p key={label} className="text-xs text-muted-foreground">
            {label}: usage not reported. Refresh to check.
          </p>
        ) : (
          <QuotaMeter
            key={label}
            now={now}
            row={{
              label,
              used: Math.max(0, value * 100),
              limit: 100,
              remaining: Math.max(0, 100 - value * 100),
              unit: "percent",
              resetAt,
              windowMs: (label === "5-hour window" ? 5 : 168) * 3_600_000,
            }}
          />
        ),
      )}
    </div>
  );
}

const POOL_STATUS: Record<PoolAccount["status"], { text: string; tone: "good" | "bad" | "idle" | "warn" }> = {
  ready: { text: "Ready", tone: "good" },
  held: { text: "Paused by a short rate limit", tone: "warn" },
  exhausted: { text: "Out of quota", tone: "bad" },
  error: { text: "Needs attention", tone: "bad" },
  disabled: { text: "Off", tone: "idle" },
};

/** The subscription this machine's CLI is signed into. */
function MachineLogin({
  provider,
  label,
  data,
  rpc,
  run,
  switching,
  onUse,
}: {
  provider: PoolId;
  label: string;
  data: Overview;
  rpc: Rpc;
  run: Run;
  switching: boolean;
  onUse: (id: string) => void;
}) {
  const local = data.pool.localLogin[provider];
  const portalScope = usePortalScopeProps();
  const alternatives = data.pool.accounts.filter((account) =>
    account.provider === provider && account.canUseMachine && account.id !== local?.stackAccountId,
  );
  const switchControl = alternatives.length ? (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <Button size="sm" variant="outline" disabled={switching} aria-label={`Switch machine ${label} account`}>
          {switching ? "Switching…" : "Switch account"}
          <Icon name="ChevronDown" className="size-3.5" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          {...portalScope}
          aria-label={`Choose machine ${label} account`}
          align="end"
          sideOffset={6}
          collisionPadding={8}
          className="z-50 min-w-48 max-w-[calc(100vw-2rem)] rounded-md border border-border bg-card p-1 text-foreground shadow-md"
        >
          {alternatives.map((account) => (
            <DropdownMenu.Item
              key={account.id}
              disabled={switching}
              onSelect={() => onUse(account.id)}
              className="cursor-pointer rounded px-3 py-2.5 text-sm outline-none data-[highlighted]:bg-state-hover data-[disabled]:opacity-50"
            >
              {account.email ?? account.label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  ) : null;
  if (!local) {
    return (
      <Notice>
        <span className="text-muted-foreground">
          This machine isn't signed in to a {label} subscription. Use a saved account, or add one below and then use it on this machine.
        </span>
        {switchControl}
      </Notice>
    );
  }
  return (
    <div className="space-y-2 rounded-lg border border-border bg-card px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground">Signed in on this machine</p>
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium">{local.email ?? `${label} account`}</span>
            {local.plan ? (
              <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium">{local.plan}</span>
            ) : null}
          </p>
        </div>
        {local.inStack ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Icon name="Check" className="size-3.5" />
            In your stack
          </span>
        ) : (
          <Button
            size="sm"
            onClick={() =>
              run(() => rpc.call("poolImport", { provider }), `Added ${local.email ?? label} to the stack`)
            }
          >
            Add to stack
          </Button>
        )}
        {switchControl}
      </div>
      {alternatives.length ? (
        <p className="text-xs text-muted-foreground">
          Switching changes this machine's CLI login. New CLI processes use it. Routing and existing conversations keep their current settings.
        </p>
      ) : null}
      <UsageDetails
        usage={local.usage}
        now={data.now}
        name={`machine ${label} login`}
        showExtraUsage={provider === "claude"}
        onRefresh={() => run(() => rpc.call("localUsageRefresh", { provider }))}
      />
    </div>
  );
}

function PoolTab({ provider, data, rpc, run }: { provider: PoolId; data: Overview; rpc: Rpc; run: Run }) {
  const label = provider === "claude" ? "Claude" : "Codex";
  const pool = data.pool;
  const accounts = pool.accounts.filter((a) => a.provider === provider);
  const [switching, setSwitching] = useState<string | null>(null);
  const switchMachine = (id: string) => {
    if (switching || !id) return;
    setSwitching(id);
    void run(() => rpc.call("poolUse", { id }), `Machine ${label} login switched`)
      .finally(() => setSwitching(null));
  };

  if (!pool.installed || !pool.enabled) {
    return (
      <div className="space-y-5">
        <MachineLogin provider={provider} label={label} data={data} rpc={rpc} run={run} switching={switching !== null} onUse={switchMachine} />
        <p className="text-sm text-muted-foreground">
          Sign in with the CLI, then choose Save it. Claude and Codex switch inside Subscription Accounts.
          Leave the Account Pooler off.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {pool.error ? <Notice tone="warn">{pool.error}</Notice> : null}

      <MachineLogin provider={provider} label={label} data={data} rpc={rpc} run={run} switching={switching !== null} onUse={switchMachine} />

      <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-card px-4 py-3">
        <Checkbox
          className="mt-0.5"
          checked={pool.routing[provider]}
          onCheckedChange={(checked) =>
            run(() => rpc.call("poolRouting", { provider, enabled: checked === true }))
          }
        />
        <span className="space-y-0.5">
          <span className="block text-sm font-medium">Route {label} threads through these accounts</span>
          <span className="block text-xs text-muted-foreground">
            Threads use the current account until it runs out, then follow this order. Existing conversations stay on their account while it has quota.
          </span>
        </span>
      </label>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">Accounts, in switching order</h2>
        <AccountList empty={`No ${label} accounts yet. Add one below.`}>
          {accounts.map((account, index) => {
            const status = POOL_STATUS[account.status];
            return (
              <li key={account.id} className="space-y-2 py-3">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <OrderArrows
                    name={account.label}
                    index={index}
                    count={accounts.length}
                    onMove={(direction) =>
                      run(() =>
                        rpc.call("poolMove", {
                          provider,
                          id: account.id,
                          direction,
                        }),
                      )
                    }
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-medium">{account.email ?? account.label}</span>
                      {account.subscriptionType ? (
                        <span className="text-xs uppercase text-muted-foreground">
                          {account.subscriptionType}
                        </span>
                      ) : null}
                    </div>
                    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Dot tone={status.tone} />
                      {status.text}
                      {account.heldUntil && account.heldUntil > data.now
                        ? ` · back in ${formatWait(account.heldUntil - data.now)}`
                        : ""}
                      {account.error ? ` · ${account.error}` : ""}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {data.pool.localLogin[provider]?.stackAccountId === account.id ? (
                      <span className="text-xs text-muted-foreground">On this machine</span>
                    ) : account.canUseMachine ? (
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`Use ${account.email ?? account.label} on this machine`}
                        disabled={switching !== null}
                        onClick={() => switchMachine(account.id)}
                      >
                        {switching === account.id ? "Switching…" : "Use on this machine"}
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Refresh usage for ${account.label}`}
                      onClick={() => run(() => rpc.call("poolRefresh", { id: account.id }))}
                    >
                      <Icon name="RefreshCw" className="size-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        run(
                          () =>
                            rpc.call("poolToggle", {
                              id: account.id,
                              enabled: !account.enabled,
                            }),
                          account.enabled ? "Account turned off" : "Account turned on",
                        )
                      }
                    >
                      {account.enabled ? "Turn off" : "Turn on"}
                    </Button>
                    <RemoveButton
                      name={account.label}
                      onRemove={() => run(() => rpc.call("poolRemove", { id: account.id }), "Removed")}
                    />
                  </div>
                </div>
                <div className="sm:pl-8">
                  <PoolUsage account={account} now={data.now} />
                </div>
              </li>
            );
          })}
        </AccountList>
      </section>

      <SignIn provider={provider} label={label} login={data.login} rpc={rpc} run={run} />
    </div>
  );
}

// ── page ──────────────────────────────────────────────────────────────────

function AllQuotas({ data, onOpenProvider }: { data: Overview; onOpenProvider: (id: ProviderId) => void }) {
  return (
    <section aria-label="All account quotas" className="space-y-3">
      <h2 className="text-sm font-medium">Current quotas</h2>
      <p className="text-xs text-muted-foreground">
        Per-account allowances and reset times. Open a provider to manage its accounts.
      </p>
      {TABS.filter((tab): tab is { id: ProviderId; label: string } => tab.id !== "all").map(
        ({ id, label }) => {
          const swap = data.swap.find((section) => section.id === id);
          const accounts = swap ? [] : data.pool.accounts.filter((account) => account.provider === id);
          const local = id === "claude" || id === "codex" ? data.pool.localLogin[id] : null;
          const localExtraMetrics = local?.inStack
            ? local.usage.metrics.filter(
                (metric) => !["5-hour window", "Weekly window"].includes(metric.label),
              )
            : [];
          const usageRows = swap
            ? swap.accounts.map((account) => ({
                key: account.name,
                name: account.email ?? account.name,
                usage: account.usage,
              }))
            : local && !local.inStack
              ? [{ key: "local", name: `${local.email ?? "Machine login"} · CLI login`, usage: local.usage }]
              : [];
          return (
            <section
              key={id}
              aria-label={`${label} quotas`}
              className="rounded-lg border border-border bg-card p-4"
            >
              <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium">{label}</h3>
                <Button
                  size="sm"
                  variant="ghost"
                  className="min-h-11 text-xs"
                  onClick={() => onOpenProvider(id)}
                >
                  Open {label}
                  <Icon name="ArrowUpRight" className="size-3.5" />
                </Button>
              </div>
              <div className="space-y-4">
                {usageRows.map(({ key, name, usage }) => {
                  const quotaRows = [...usage.metrics.filter((row) => !row.derivedFromModels), ...(usage.modelQuotas ?? [])];
                  const loginExpired = isLoginExpired(usage);
                  return (
                  <div key={key} className="space-y-2">
                    <p className="break-words text-xs text-muted-foreground">
                      {name}
                      {usage.plan ? ` · ${usage.plan}` : ""}
                    </p>
                    {quotaRows.length ? (
                      <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
                        {quotaRows.map((metric) => (
                          <QuotaMeter
                            key={metric.scope?.kind === "model" ? `model:${metric.scope.model}` : metric.label}
                            row={metric}
                            now={data.now}
                            historical={isHistoricalUsage(usage, data.now)}
                          />
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        {usage.status === "loading"
                          ? "Fetching subscription usage…"
                          : "Quota unavailable. Open this provider to check its connection."}
                      </p>
                    )}
                    {usage.error ? (
                      <p className="break-words text-xs text-destructive">
                        {loginExpired ? "Login expired. Log in again to load usage." : usage.error}
                        {quotaRows.length ? " · Last known usage" : ""}
                      </p>
                    ) : null}
                  </div>
                  );
                })}
                {accounts.map((account) => (
                  <div key={account.id} className="space-y-2">
                    <p className="break-words text-xs text-muted-foreground">
                      {account.email ?? account.label}
                      {account.subscriptionType ? ` · ${account.subscriptionType}` : ""} ·{" "}
                      {POOL_STATUS[account.status].text}
                    </p>
                    <PoolUsage account={account} now={data.now} />
                    {account.error ? (
                      <p className="break-words text-xs text-destructive">{account.error}</p>
                    ) : null}
                  </div>
                ))}
                {local && localExtraMetrics.length ? (
                  <div className="space-y-2">
                    <p className="break-words text-xs text-muted-foreground">
                      {local.email ?? "Machine login"} · CLI allowances
                      {local.usage.plan ? ` · ${local.usage.plan}` : ""}
                    </p>
                    <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
                      {localExtraMetrics.map((metric) => (
                        <QuotaMeter key={metric.label} row={metric} now={data.now} historical={isHistoricalUsage(local.usage, data.now)} />
                      ))}
                    </div>
                    {local.usage.error ? (
                      <p className="break-words text-xs text-destructive">
                        {isLoginExpired(local.usage)
                          ? "Login expired. Log in again to load usage."
                          : local.usage.error}{" "}
                        · Last known usage
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {!usageRows.length && !accounts.length && !localExtraMetrics.length ? (
                  <p className="text-xs text-muted-foreground">
                    No connected accounts. Open {label} to add one.
                  </p>
                ) : null}
              </div>
            </section>
          );
        },
      )}
    </section>
  );
}

function tabSummary(id: TabId, data: Overview): { count: number; tone: "good" | "bad" | "idle" | "warn" } {
  if (id === "all") return { count: 0, tone: "idle" };
  const section = data.swap.find((s) => s.id === id);
  if (section || (id !== "claude" && id !== "codex")) {
    const accounts = section?.accounts ?? [];
    const ready = accounts.filter((a) => a.exhaustedUntil <= data.now).length;
    return {
      count: accounts.length,
      tone: accounts.length === 0 ? "idle" : ready > 0 ? "good" : "bad",
    };
  }
  const accounts = data.pool.accounts.filter((a) => a.provider === id);
  const ready = accounts.filter((a) => a.status === "ready").length;
  return {
    count: accounts.length,
    tone: accounts.length === 0 ? "idle" : ready > 0 ? "good" : "bad",
  };
}

function AccountsPage() {
  const { rpc, data, error, run, refetch } = useOverview();
  const [tab, setTab] = useState<TabId>("antigravity");

  if (!data) {
    return (
      <Frame>
        <p role="status" className="text-sm text-muted-foreground">
          {error ?? "Loading accounts and subscription usage…"}
        </p>
        {error ? (
          <Button variant="outline" onClick={refetch}>
            Retry loading accounts
          </Button>
        ) : null}
      </Frame>
    );
  }

  const swapSection = data.swap.find((s) => s.id === tab);

  return (
    <Frame>
      <div>
        <h1 className="text-lg font-semibold">Subscription accounts</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Check usage and remaining quota before switching accounts. Usage updates every five minutes.
        </p>
      </div>
      {error ? (
        <Notice tone="warn">
          <span className="flex-1">
            Could not update accounts: {error}. Showing the last loaded accounts.
          </span>
          <Button size="sm" variant="outline" onClick={refetch}>
            Retry
          </Button>
        </Notice>
      ) : null}
      <div role="tablist" aria-label="Subscriptions" className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map(({ id, label }) => {
          const summary = tabSummary(id, data);
          const selected = tab === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              id={`subscription-tab-${id}`}
              aria-selected={selected}
              aria-controls="subscription-panel"
              tabIndex={selected ? 0 : -1}
              onClick={() => setTab(id)}
              onKeyDown={(event) => {
                const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
                if (!offset && event.key !== "Home" && event.key !== "End") return;
                event.preventDefault();
                const next =
                  event.key === "Home"
                    ? TABS[0]
                    : event.key === "End"
                      ? TABS[TABS.length - 1]
                      : TABS[(TABS.findIndex((item) => item.id === id) + offset + TABS.length) % TABS.length];
                setTab(next.id);
                document.getElementById(`subscription-tab-${next.id}`)?.focus();
              }}
              className={cn(
                "-mb-px flex min-h-11 items-center gap-2 border-b-2 px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                selected
                  ? "border-foreground font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {summary.count > 0 ? <Dot tone={summary.tone} /> : null}
              {label}
              {summary.count > 0 ? (
                <span className="text-xs text-muted-foreground">{summary.count}</span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div id="subscription-panel" role="tabpanel" aria-labelledby={`subscription-tab-${tab}`}>
        {tab === "all" ? (
          <AllUsage
            data={data}
            onOpenProvider={setTab}
            onRefresh={() =>
              run(async () => {
                const tasks = [
                  ...(["claude", "codex", "grok"] as const).map((provider) =>
                    rpc.call("historyRefresh", { provider }),
                  ),
                  ...data.swap.flatMap((section) =>
                    section.accounts.map((account) =>
                      rpc.call("usageRefresh", { provider: section.id, name: account.name }),
                    ),
                  ),
                  ...(["claude", "codex"] as const)
                    .filter((provider) => data.pool.localLogin[provider])
                    .map((provider) => rpc.call("localUsageRefresh", { provider })),
                  ...data.pool.accounts.map((account) => rpc.call("poolRefresh", { id: account.id })),
                ];
                const results = await Promise.allSettled(tasks);
                const failures = results.filter((result) => result.status === "rejected");
                if (failures.length) {
                  refetch();
                  throw new Error(
                    `${failures.length} usage sources could not refresh. Open their provider tabs for details.`,
                  );
                }
              })
            }
          >
            <AllQuotas data={data} onOpenProvider={setTab} />
          </AllUsage>
        ) : swapSection ? (
          <>
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-card px-4 py-3">
              <Checkbox
                className="mt-0.5"
                checked={data.autoSwitch}
                onCheckedChange={(checked) =>
                  run(() => rpc.call("setAutoSwitch", { enabled: checked === true }))
                }
              />
              <span className="space-y-0.5">
                <span className="block text-sm font-medium">Switch automatically when quota runs out</span>
                <span className="block text-xs text-muted-foreground">
                  When a thread hits the limit, bb moves to the next account in the list and retries the turn.
                  If every account is used up, it waits for the first one to reset. Applies to Antigravity,
                  Claude, Codex, Cursor and Grok.
                </span>
              </span>
            </label>
            <div className="mt-5">
              <SwapTab section={swapSection} data={data} rpc={rpc} run={run} />
            </div>
          </>
        ) : (
          <PoolTab provider={tab as PoolId} data={data} rpc={rpc} run={run} />
        )}
        {tab !== "all" ? (
          <div className="mt-5 space-y-3">
            {tab !== "cursor" && tab !== "antigravity" && data.history?.[tab] ? (
              <HistoryPanel
                key={tab}
                history={data.history[tab]}
                now={data.now}
                name={TABS.find((item) => item.id === tab)!.label}
                onRefresh={() => run(() => rpc.call("historyRefresh", { provider: tab }))}
              />
            ) : null}
            {tab === "antigravity" ? (
              <p className="text-xs text-muted-foreground">
                Usage trend unavailable · Antigravity’s quota API does not provide daily token history.
              </p>
            ) : null}
            <ProviderLinks provider={tab} />
          </div>
        ) : null}
      </div>
    </Frame>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl space-y-5 px-4 pb-6 pt-3 md:px-5 md:pt-4">
        {children}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "accounts",
    title: "Subscription Accounts",
    icon: "Layers",
    path: "accounts",
    component: AccountsPage,
  });
});
