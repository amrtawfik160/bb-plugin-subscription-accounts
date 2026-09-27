// Subscription Accounts page: one tab per AI subscription. Antigravity, Cursor
// and Grok accounts are swapped by this plugin; Claude and Codex accounts are
// managed through bb's Account Pooler, shown here in the same layout.
import { useCallback, useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type SwapId = "antigravity" | "cursor" | "grok";
type PoolId = "claude" | "codex";
type TabId = SwapId | PoolId;

interface SwapAccount {
  name: string;
  email: string | null;
  active: boolean;
  exhaustedUntil: number;
  lastError: string | null;
}
interface SwapSection {
  id: SwapId;
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
}
interface Login {
  provider: string;
  status: "starting" | "waiting" | "verifying" | "done" | "failed";
  url: string | null;
  userCode: string | null;
  needsCode: boolean;
  expiresAt: number | null;
  error: string | null;
  account: string | null;
}
interface Overview {
  now: number;
  autoSwitch: boolean;
  swap: SwapSection[];
  pool: {
    installed: boolean;
    enabled: boolean;
    routing: Record<PoolId, boolean>;
    accounts: PoolAccount[];
    error: string | null;
    localLogin: Record<PoolId, boolean>;
  };
  login: Login | null;
}

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type Run = (task: () => Promise<unknown>, done?: string) => Promise<void>;

const CHANGED = "accounts-changed";
const TABS: { id: TabId; label: string }[] = [
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
  const refetch = useCallback(() => {
    rpc.call("overview").then(
      (next) => {
        setData(next as Overview);
        setError(null);
      },
      (cause) => setError(message(cause)),
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
  return { rpc, data, error, run };
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

// ── sign-in ───────────────────────────────────────────────────────────────

function SignIn({
  provider,
  label,
  login,
  rpc,
  run,
  disabled,
  children,
}: {
  provider: TabId;
  label: string;
  login: Login | null;
  rpc: Rpc;
  run: Run;
  disabled?: boolean;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const mine = login && login.provider === provider ? login : null;
  const status = mine?.status ?? null;
  const waiting = status === "waiting";
  const now = useNow(1_000, waiting);
  const left = mine?.expiresAt ? Math.max(0, mine.expiresAt - now) : 0;

  useEffect(() => {
    if (status === "done" && open) {
      toast.success(`Added ${mine?.account ?? "account"}`);
      setOpen(false);
      setCode("");
    }
  }, [status, open, mine?.account]);

  const start = () => {
    setOpen(true);
    setCode("");
    void run(() => rpc.call("loginStart", { provider }));
  };
  const cancel = () => {
    setOpen(false);
    void run(() => rpc.call("loginCancel"));
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (code.trim()) void run(() => rpc.call("loginSubmit", { code }));
  };

  if (!open || !mine || status === "done") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={start} disabled={disabled}>
          <Icon name="Plus" className="size-4" />
          Add {label} account
        </Button>
        {children}
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-4">
        <h3 className="font-medium">Add a {label} account</h3>
        <Button size="sm" variant="ghost" onClick={cancel}>
          Cancel
        </Button>
      </div>

      {status === "starting" ? <p className="text-sm text-muted-foreground">Getting a sign-in link…</p> : null}

      {status === "failed" ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-destructive">{mine.error}</p>
          <Button size="sm" onClick={start}>
            Try again
          </Button>
        </div>
      ) : null}

      {waiting || status === "verifying" ? (
        <ol className="space-y-4 text-sm">
          <li className="space-y-2">
            <p>
              <span className="font-medium">1.</span> Open the sign-in page and sign in with the account you want to
              add.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button asChild size="sm" variant="outline">
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
              <form onSubmit={submit} className="flex items-center gap-2">
                <Input
                  autoFocus
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  placeholder="Authorization code"
                  aria-label="Authorization code"
                  disabled={!waiting}
                  className="font-mono"
                />
                <Button type="submit" disabled={!waiting || !code.trim()}>
                  {status === "verifying" ? "Signing in…" : "Add"}
                </Button>
              </form>
            </li>
          ) : (
            <li>
              <p className="text-muted-foreground">
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
          {section.accounts.length} saved · {ready} with quota left
        </span>
      </p>

      {!section.installed ? (
        <Notice tone="warn">The {section.label} CLI is not installed on the bb server machine.</Notice>
      ) : null}

      {section.live.signedIn && !section.live.saved ? (
        <Notice>
          <span className="flex-1">
            {section.label} is signed in{section.live.email ? (
              <>
                {" "}
                as <span className="font-medium">{section.live.email}</span>
              </>
            ) : null}
            , and that login isn't in your list.
          </span>
          <Button
            size="sm"
            onClick={() => run(() => rpc.call("saveCurrent", { provider: section.id }), "Saved the current login")}
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
            return (
              <li key={account.name} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
                <OrderArrows
                  name={account.name}
                  index={index}
                  count={section.accounts.length}
                  onMove={(direction) => run(() => rpc.call("move", { ...target(account.name), direction }))}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium">{account.name}</span>
                    {account.email ? (
                      <span className="truncate text-sm text-muted-foreground">{account.email}</span>
                    ) : null}
                  </div>
                  <span
                    className={cn(
                      "inline-flex items-center gap-1.5 text-xs",
                      out ? "text-destructive" : account.active ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    <Dot tone={out ? "bad" : account.active ? "good" : "idle"} />
                    {account.active ? (out ? "In use · out of quota" : "In use") : null}
                    {!account.active && out ? `Out of quota · back in ${formatWait(account.exhaustedUntil - now)}` : null}
                    {!account.active && !out ? "Ready" : null}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  {out ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => run(() => rpc.call("reset", target(account.name)), `${account.name} marked ready`)}
                    >
                      <Icon name="RotateCcw" className="size-3.5" />
                      Mark ready
                    </Button>
                  ) : account.active ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => run(() => rpc.call("markUsed", target(account.name)), "Moved to the next account")}
                    >
                      Skip to next
                    </Button>
                  ) : null}
                  {!account.active ? (
                    <Button size="sm" onClick={() => run(() => rpc.call("use", target(account.name)), `Now using ${account.name}`)}>
                      Use now
                    </Button>
                  ) : null}
                  <RemoveButton
                    name={account.name}
                    onRemove={() => run(() => rpc.call("remove", target(account.name)), `Removed ${account.name}`)}
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

// ── Claude / Codex through the Account Pooler ─────────────────────────────

function Usage({ label, value, resetAt, now }: { label: string; value: number | null; resetAt: number | null; now: number }) {
  if (value === null) return null;
  // The pooler reports utilization as a 0–1 fraction.
  const pct = Math.round(value * 100);
  return (
    <div className="flex min-w-36 flex-1 items-center gap-2 text-xs text-muted-foreground">
      <span className="w-6 shrink-0">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted" aria-label={`${label} usage ${pct}%`}>
        <div
          className={cn("h-full rounded-full", pct >= 90 ? "bg-destructive" : pct >= 70 ? "bg-warning" : "bg-success")}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
      <span className="w-20 shrink-0 text-right tabular-nums">
        {pct}%{resetAt && resetAt > now ? ` · ${formatWait(resetAt - now)}` : ""}
      </span>
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

function PoolTab({ provider, data, rpc, run }: { provider: PoolId; data: Overview; rpc: Rpc; run: Run }) {
  const label = provider === "claude" ? "Claude" : "Codex";
  const pool = data.pool;
  const accounts = pool.accounts.filter((a) => a.provider === provider);

  if (!pool.installed) {
    return <Notice tone="warn">This bb does not include the Account Pooler plugin, which {label} accounts need.</Notice>;
  }
  if (!pool.enabled) {
    return (
      <div className="space-y-3 rounded-lg border border-border bg-card p-4 text-sm">
        <p className="font-medium">{label} accounts run through bb's Account Pooler</p>
        <p className="text-muted-foreground">
          The pooler sends {label} traffic to whichever saved account still has quota, so a long task keeps going when
          one plan runs out. Turning it on changes nothing until you add an account.
        </p>
        <Button onClick={() => run(() => rpc.call("poolEnable"), "Account Pooler is on")}>Turn on</Button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {pool.error ? <Notice tone="warn">{pool.error}</Notice> : null}

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
            New turns use the first account below that has quota. When it runs out, the next one takes over.
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
                    onMove={(direction) => run(() => rpc.call("poolMove", { provider, id: account.id, direction }))}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-medium">{account.email ?? account.label}</span>
                      {account.subscriptionType ? (
                        <span className="text-xs uppercase text-muted-foreground">{account.subscriptionType}</span>
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
                  <div className="flex items-center gap-1.5">
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
                          () => rpc.call("poolToggle", { id: account.id, enabled: !account.enabled }),
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
                <div className="flex flex-wrap gap-x-6 gap-y-1 pl-8">
                  <Usage label="5h" value={account.fiveHourUtilization} resetAt={account.fiveHourResetAt} now={data.now} />
                  <Usage label="7d" value={account.sevenDayUtilization} resetAt={account.sevenDayResetAt} now={data.now} />
                </div>
              </li>
            );
          })}
        </AccountList>
      </section>

      <SignIn provider={provider} label={label} login={data.login} rpc={rpc} run={run}>
        {pool.localLogin[provider] ? (
          <Button
            variant="outline"
            onClick={() => run(() => rpc.call("poolImport", { provider }), `Imported this machine's ${label} login`)}
          >
            Import this machine's login
          </Button>
        ) : null}
      </SignIn>
    </div>
  );
}

// ── page ──────────────────────────────────────────────────────────────────

function tabSummary(id: TabId, data: Overview): { count: number; tone: "good" | "bad" | "idle" | "warn" } {
  if (id === "claude" || id === "codex") {
    const accounts = data.pool.accounts.filter((a) => a.provider === id);
    const ready = accounts.filter((a) => a.status === "ready").length;
    return { count: accounts.length, tone: accounts.length === 0 ? "idle" : ready > 0 ? "good" : "bad" };
  }
  const section = data.swap.find((s) => s.id === id);
  const accounts = section?.accounts ?? [];
  const ready = accounts.filter((a) => a.exhaustedUntil <= data.now).length;
  return { count: accounts.length, tone: accounts.length === 0 ? "idle" : ready > 0 ? "good" : "bad" };
}

function AccountsPage() {
  const { rpc, data, error, run } = useOverview();
  const [tab, setTab] = useState<TabId>("antigravity");

  if (!data) {
    return (
      <Frame>
        <p role="status" className="text-sm text-muted-foreground">
          {error ?? "Loading accounts…"}
        </p>
      </Frame>
    );
  }

  const swapSection = data.swap.find((s) => s.id === tab);

  return (
    <Frame>
      <div role="tablist" aria-label="Subscriptions" className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map(({ id, label }) => {
          const summary = tabSummary(id, data);
          const selected = tab === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setTab(id)}
              className={cn(
                "-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm",
                selected
                  ? "border-foreground font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {summary.count > 0 ? <Dot tone={summary.tone} /> : null}
              {label}
              {summary.count > 0 ? <span className="text-xs text-muted-foreground">{summary.count}</span> : null}
            </button>
          );
        })}
      </div>

      {swapSection ? (
        <>
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-card px-4 py-3">
            <Checkbox
              className="mt-0.5"
              checked={data.autoSwitch}
              onCheckedChange={(checked) => run(() => rpc.call("setAutoSwitch", { enabled: checked === true }))}
            />
            <span className="space-y-0.5">
              <span className="block text-sm font-medium">Switch automatically when quota runs out</span>
              <span className="block text-xs text-muted-foreground">
                When a thread hits the limit, bb moves to the next account in the list and retries the turn. If every
                account is used up, it waits for the first one to reset. Applies to Antigravity, Cursor and Grok.
              </span>
            </span>
          </label>
          <SwapTab section={swapSection} data={data} rpc={rpc} run={run} />
        </>
      ) : (
        <PoolTab provider={tab as PoolId} data={data} rpc={rpc} run={run} />
      )}
    </Frame>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl space-y-5 px-4 pb-6 pt-3 md:px-5 md:pt-4">{children}</div>
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
