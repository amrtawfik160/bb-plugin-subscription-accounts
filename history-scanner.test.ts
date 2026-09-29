import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { aggregateHistory, createLogParser, dedupHistory, HistoryCache } from "./history";
import { discoverHistory } from "./history-discovery";
import { MAX_RECORD_BYTES, readJSONL } from "./jsonl-scanner";
import { sqliteHistoryStore } from "./history-store";
import { fetchCursorHistory, parseCursorHistory } from "./cursor-history";
import { createUsageClient } from "./usage-client";

const now = Date.now(),
  timestamp = new Date(now).toISOString();
const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const temp = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "subscription-complete-history-"));
  directories.push(dir);
  return dir;
};
const claude = (id: string, input = 100, extra: Record<string, unknown> = {}) => ({
  timestamp,
  requestId: "request",
  message: { id, model: "claude-opus-5-5", usage: { input_tokens: input, output_tokens: 10 } },
  ...extra,
});
const write = async (file: string, rows: unknown[]) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
};
const total = (cache: HistoryCache, provider: "claude" | "codex" | "grok") =>
  cache.get(provider).days.reduce((n, d) => n + d.tokens, 0);

describe("complete OpenUsage history scans", () => {
  it("loads files above 64MB and over 256MB combined on the first refresh, with stable repeated totals", async () => {
    const home = await temp(),
      dir = path.join(home, ".claude/projects/test");
    await fs.mkdir(dir, { recursive: true });
    // Sparse padding keeps the regression cheap on disk while exercising the original real byte limits.
    for (let i = 0; i < 7; i++) {
      const size = (i === 6 ? 65 : 48) * 1024 * 1024;
      const file = await fs.open(path.join(dir, `${i}.jsonl`), "w");
      try {
        await file.truncate(size);
        for (let offset = 512 * 1024 - 1; offset < size; offset += 512 * 1024)
          await file.write(Buffer.from("\n"), 0, 1, offset);
        await file.write(JSON.stringify(claude(String(i))) + "\n", size);
      } finally {
        await file.close();
      }
    }
    const cache = new HistoryCache(vi.fn(), home, {}, () => now);
    try {
      for (let pass = 0; pass < 3; pass++) {
        await cache.refresh("claude", true);
        expect(cache.get("claude")).toMatchObject({
          status: "ready",
          partial: false,
          scan: { files: 7, oversizedRecords: 0, unreadableFiles: 0 },
        });
        expect(total(cache, "claude")).toBe(770);
        expect(cache.get("claude").models[0].events).toBe(7);
      }
    } finally {
      cache.dispose();
    }
  }, 60000);
  it("discovers deep logs, symlinked homes, direct Codex roots and active/archive precedence", async () => {
    const home = await temp(),
      config = path.join(home, "real-codex");
    await write(path.join(config, "sessions/a/session.jsonl"), [{ first: true }]);
    await write(path.join(config, "archived_sessions/a/session.jsonl"), [{ duplicate: true }]);
    await write(path.join(config, "archived_sessions/b/deep", ...Array(15).fill("nested"), "other.jsonl"), [
      { second: true },
    ]);
    await fs.symlink(config, path.join(home, "symlink-codex"));
    const discovered = await discoverHistory(
      "codex",
      home,
      { CODEX_HOME: path.join(home, "symlink-codex") },
      () => false,
    );
    expect(discovered.files).toHaveLength(2);
    expect(
      discovered.files.some(
        (f) => f.path.includes("sessions/a/session.jsonl") && !f.path.includes("archived_sessions"),
      ),
    ).toBe(true);
    expect(discovered.partial).toBe(false);
    const direct = path.join(home, "direct");
    await write(path.join(direct, "old.jsonl"), []);
    expect((await discoverHistory("codex", home, { CODEX_HOME: direct }, () => false)).files).toHaveLength(1);
  });
  it("discovers Claude config lists, projects aliases and Cowork sessions, and all Grok child ledgers", async () => {
    const home = await temp(),
      config = path.join(home, "claude-other");
    await write(path.join(config, "projects/one.jsonl"), []);
    await write(
      path.join(
        home,
        "Library/Application Support/Claude/local-agent-mode-sessions/group/org/agent/local_child/.claude/projects/two.jsonl",
      ),
      [],
    );
    expect(
      (await discoverHistory("claude", home, { CLAUDE_CONFIG_DIR: ` , ${config}/projects, ` }, () => false))
        .files,
    ).toHaveLength(2);
    await write(path.join(home, ".grok/sessions/parent/updates.jsonl"), []);
    await write(path.join(home, ".grok/sessions/child/updates.jsonl"), []);
    await write(path.join(home, ".grok/sessions/child/debug.jsonl"), []);
    expect((await discoverHistory("grok", home, {}, () => false)).files).toHaveLength(2);
  });
  it("keeps file parser state across chunks, skips oversized records, and parses the final unterminated line", async () => {
    const dir = await temp(),
      file = path.join(dir, "session.jsonl");
    const context = JSON.stringify({ type: "turn_context", payload: { model_name: "gpt-6.1-sol" } }) + "\n";
    const tokens = JSON.stringify({
      type: "event_msg",
      timestamp,
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            prompt_tokens: 100,
            completion_tokens: 10,
            cached_tokens: 50,
            total_tokens: 110,
          },
        },
      },
    });
    await fs.writeFile(file, context + "x".repeat(MAX_RECORD_BYTES + 1) + "\n" + tokens);
    const stat = await fs.stat(file),
      parser = createLogParser("codex");
    const result = await readJSONL(
      { path: file, size: stat.size, mtime: stat.mtimeMs },
      (line) => {
        try {
          return parser(JSON.parse(line));
        } catch {
          return [];
        }
      },
      () => false,
    );
    expect(result.partial).toBe(true);
    expect(result.items).toMatchObject([
      { model: "gpt-6.1-sol", tokens: 110, tokenUsage: { input: 50, cacheRead: 50, output: 10 } },
    ]);
  });
  it("persists only parsed usage, reuses it after restart, and reparses corrupt cache records", async () => {
    const home = await temp(),
      source = path.join(home, ".claude/projects/test/session.jsonl");
    await write(source, [
      claude("id", 100, { privateText: "private-transcript", credentials: "test-access-token" }),
    ]);
    const db = new Database(path.join(home, "cache.db"));
    db.exec(
      "CREATE TABLE usage_log_cache(provider TEXT,identity TEXT,path TEXT,size INTEGER,mtime REAL,schema_version INTEGER,body TEXT,updated_at INTEGER,PRIMARY KEY(provider,identity,path))",
    );
    const store = sqliteHistoryStore(db),
      put = vi.spyOn(store, "put");
    const make = () => new HistoryCache(vi.fn(), home, {}, () => now, undefined, store);
    let cache = make();
    try {
      await cache.refresh("claude");
      expect(total(cache, "claude")).toBe(110);
      expect(put).toHaveBeenCalledTimes(1);
      expect((db.prepare("SELECT body FROM usage_log_cache").get() as { body: string }).body).not.toMatch(
        /private-transcript|test-access-token/,
      );
      cache.dispose();
      cache = make();
      await cache.refresh("claude");
      expect(total(cache, "claude")).toBe(110);
      expect(put).toHaveBeenCalledTimes(1);
      db.prepare("UPDATE usage_log_cache SET body=?").run("broken cache");
      cache.dispose();
      cache = make();
      await cache.refresh("claude");
      expect(total(cache, "claude")).toBe(110);
      expect(put).toHaveBeenCalledTimes(2);
      await fs.appendFile(source, JSON.stringify(claude("second", 200)) + "\n");
      await cache.refresh("claude", true);
      expect(total(cache, "claude")).toBe(320);
      await fs.unlink(source);
      await cache.refresh("claude", true);
      expect(cache.get("claude").days).toEqual([]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM usage_log_cache").get()).toMatchObject({ n: 0 });
    } finally {
      cache.dispose();
      db.close();
    }
  });
  it("does not publish incomplete scans when disposed", async () => {
    const home = await temp();
    await write(path.join(home, ".claude/projects/test/session.jsonl"), [claude("one")]);
    const changed = vi.fn(),
      cache = new HistoryCache(changed, home, {}, () => now);
    const pending = cache.refresh("claude");
    cache.dispose();
    await pending;
    expect(changed).not.toHaveBeenCalled();
    expect(cache.get("claude").days).toEqual([]);
  });
});

describe("OpenUsage provider parser parity", () => {
  it("deduplicates Claude by message + request, preferring parent, larger usage and explicit speed", () => {
    const parse = createLogParser("claude");
    const side = parse(claude("same", 1000, { requestId: "side", isSidechain: true }));
    const parent = parse(claude("same", 20, { requestId: "parent" }));
    const anotherRequest = parse(claude("same", 30, { requestId: "different" }));
    const deduped = dedupHistory([...side, ...parent, ...side, ...anotherRequest]);
    expect(deduped.map((e) => e.tokens)).toEqual([30, 40]);
    const richer = parse({
      ...claude("same", 20),
      message: {
        id: "same",
        model: "claude-opus-5-5",
        usage: { input_tokens: 20, output_tokens: 10, speed: "fast" },
      },
    });
    const standard = parse(claude("same", 20));
    expect(dedupHistory([...standard, ...richer])[0].tokenUsage?.fast).toBe(true);
  });
  it("counts advisor iterations separately, tolerates null ordinary iteration models, and rejects foreign/null schema fields", () => {
    const parse = createLogParser("claude");
    const row = claude("one");
    const events = parse({
      ...row,
      message: {
        ...row.message,
        usage: {
          ...row.message.usage,
          iterations: [
            { type: "message", model: null, input_tokens: 100, output_tokens: 10 },
            { type: "advisor_message", model: "claude-opus-5-5", input_tokens: 50, output_tokens: 5 },
          ],
        },
      },
    });
    expect(events.map((e) => e.tokens)).toEqual([110, 55]);
    expect(dedupHistory([...events, ...events])).toHaveLength(2);
    expect(parse({ ...row, version: "foreign" })).toEqual([]);
    expect(parse({ ...row, sessionId: null })).toEqual([]);
    expect(parse({ ...row, privateNested: { model: null } })).toHaveLength(1);
  });
  it("uses Codex legacy aliases, fallback models, service tiers, and exact event dedup across copied logs", () => {
    const parse = createLogParser("codex");
    const row = {
      type: "event_msg",
      timestamp,
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            prompt_tokens: 100,
            completion_tokens: 10,
            cached_tokens: 50,
            reasoning_tokens: 5,
          },
        },
      },
    };
    const fallback = parse(row);
    expect(fallback).toMatchObject([
      { model: "gpt-5", tokens: 115, tokenUsage: { input: 50, cacheRead: 50, output: 10 } },
    ]);
    parse({ type: "turn_context", payload: { metadata: { model: "gpt-reserve" } } });
    parse({ type: "event_msg", payload: { type: "thread_settings_applied", service_tier: "priority" } });
    const reserve = parse(row);
    expect(reserve).toMatchObject([
      { model: "gpt-reserve", pricingModel: "gpt-5.6-luna", tokenUsage: { fast: true } },
    ]);
    expect(dedupHistory([...reserve, ...reserve])).toHaveLength(1);
    parse({ type: "turn_context", payload: { model: "codex-auto-review" } });
    expect(parse(row)[0].pricingModel).toBe("gpt-5.6-luna");
  });
  it("does not mistake null/blank child markers for a child and opens undated child gates at a live task", () => {
    const root = createLogParser("codex");
    root({
      type: "session_meta",
      payload: { forked_from_id: null, parent_thread_id: " ", source: { subagent: "" } },
    });
    const usage = {
      type: "event_msg",
      timestamp,
      payload: { type: "token_count", info: { last_token_usage: { input_tokens: 10 } } },
    };
    expect(root(usage)).toHaveLength(1);
    const child = createLogParser("codex");
    child({ type: "session_meta", payload: { source: { subagent: {} } } });
    expect(child(usage)).toEqual([]);
    child({
      type: "event_msg",
      timestamp,
      payload: { type: "task_started", started_at: Math.floor(now / 1000) },
    });
    expect(child(usage)).toHaveLength(1);
  });
  it("keeps the first Grok notification per event ID/model and includes each model once", () => {
    const parse = createLogParser("grok");
    const rows = parse({
      timestamp: now / 1000,
      params: {
        _meta: { eventId: "event", agentTimestampMs: 0 },
        update: {
          sessionUpdate: "turn_completed",
          usage: {
            modelUsage: {
              a: { inputTokens: 100, outputTokens: 10 },
              b: { inputTokens: 200, outputTokens: 20 },
            },
          },
        },
      },
    });
    expect(rows).toHaveLength(2);
    expect(dedupHistory([...rows, ...rows])).toHaveLength(2);
    expect(aggregateHistory([...rows, ...rows], now).models.map((m) => m.tokens)).toEqual([220, 110]);
  });
});

describe("OpenUsage Cursor history fetch parity", () => {
  it("matches Cursor CSV quoting, CR-only records and structural rejection", () => {
    const header = "Date,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens";
    const csv = `${header}\r${timestamp},"a,""b""",0,100,0,10\r`;
    expect(parseCursorHistory(csv, now).models).toMatchObject([{ model: 'a,"b"', tokens: 110 }]);
    expect(() => parseCursorHistory(`${header}\n${timestamp},a"b,0,100,0,10\n`, now)).toThrow();
  });
  it("fetches the complete 30-calendar-day token export with the session cookie and accepts exports above 16MB", async () => {
    const header = "Date,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens\n";
    const body =
      header.trimEnd() + `,Note\n${timestamp},gpt-6.1-sol,0,100,10,5,${"x".repeat(17 * 1024 * 1024)}\n`;
    const fetcher = vi.fn(async () => new Response(body));
    const history = await fetchCursorHistory(fetcher as unknown as typeof fetch, "test-session-cookie");
    expect(history).toMatchObject({ status: "ready", partial: false, models: [{ tokens: 115 }] });
    const [url, options] = (fetcher.mock.calls as unknown as [string, RequestInit][])[0];
    const request = new URL(url);
    expect(request.origin + request.pathname).toBe(
      "https://cursor.com/api/dashboard/export-usage-events-csv",
    );
    expect(request.searchParams.get("strategy")).toBe("tokens");
    expect(options.headers).toEqual({ Cookie: "test-session-cookie", Accept: "text/csv" });
    expect(options.redirect).toBe("error");
  }, 30000);
  it("uses the second JWT subject component, matching OpenUsage rather than the last component", async () => {
    const access = `header.${Buffer.from(JSON.stringify({ sub: "auth|correct-user|extra", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
    const fetcher = vi.fn(async (url: string) =>
      url.includes("export-usage")
        ? new Response(
            `Date,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens\n${timestamp},gpt-6.1-sol,0,100,0,10\n`,
          )
        : Response.json({ planUsage: { limit: 2000, totalSpend: 100 } }),
    );
    const client = createUsageClient(fetcher as unknown as typeof fetch);
    const result = await client("cursor", JSON.stringify({ accessToken: access }), async () => {});
    expect(result.history?.status).toBe("ready");
    const call = (fetcher.mock.calls as unknown as [string, RequestInit][]).find(([url]) =>
      url.includes("export-usage"),
    )!;
    expect((call[1].headers as Record<string, string>).Cookie).toBe(
      `WorkosCursorSessionToken=correct-user%3A%3A${access}`,
    );
  });
});
