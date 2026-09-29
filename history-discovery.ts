// Ported from OpenUsage's Claude/Codex/Grok log scanner discovery (MIT).
import fs from "node:fs/promises";
import path from "node:path";
import { jsonlFiles, type DiscoveredFile } from "./jsonl-scanner.js";

export type LocalProvider = "claude" | "codex" | "grok";
export async function discoverHistory(
  provider: LocalProvider,
  home: string,
  env: NodeJS.ProcessEnv,
  cancelled: () => boolean,
) {
  const expand = (value: string) => path.resolve(value.replace(/^~(?=\/|$)/, home));
  const configured =
    env[
      provider === "claude" ? "CLAUDE_CONFIG_DIR" : provider === "codex" ? "CODEX_HOME" : "GROK_HOME"
    ]?.trim();
  const homes = configured
    ? (provider === "grok" ? [configured] : configured.split(","))
        .map((s) => s.trim())
        .filter(Boolean)
        .map(expand)
    : provider === "claude"
      ? [
          path.join(
            env.XDG_CONFIG_HOME?.trim() ? expand(env.XDG_CONFIG_HOME.trim()) : path.join(home, ".config"),
            "claude",
          ),
          path.join(home, ".claude"),
        ]
      : [path.join(home, `.${provider}`)];
  const dirs = homes.map((dir) =>
    provider === "claude" && path.basename(dir) === "projects" ? path.dirname(dir) : dir,
  );
  const identity = (await Promise.all(dirs.map((dir) => fs.realpath(dir).catch(() => dir))))
    .sort()
    .join("\n");
  let partial = false;
  const files: DiscoveredFile[] = [],
    seenDirs = new Set<string>(),
    seenFiles = new Set<string>();
  const add = async (dir: string, seenRelative?: Set<string>) => {
    const resolved = await fs.realpath(dir).catch(() => dir);
    if (seenDirs.has(resolved)) return;
    seenDirs.add(resolved);
    const result = await jsonlFiles(resolved, cancelled);
    partial ||= result.partial;
    for (const file of result.files) {
      if (provider === "grok" && path.basename(file.path) !== "updates.jsonl") continue;
      const relative = path.relative(resolved, file.path);
      if (seenRelative?.has(relative) || seenFiles.has(file.path)) continue;
      seenRelative?.add(relative);
      seenFiles.add(file.path);
      files.push(file);
    }
  };
  const isDir = async (dir: string) => (await fs.stat(dir).catch(() => null))?.isDirectory() ?? false;
  for (const dir of dirs) {
    if (provider === "codex") {
      const sources: string[] = [];
      for (const name of ["sessions", "archived_sessions"]) {
        const source = path.join(dir, name);
        if (await isDir(source)) sources.push(source);
      }
      const seenRelative = new Set<string>();
      for (const source of sources.length ? sources : [dir]) await add(source, seenRelative);
    } else await add(path.join(dir, provider === "claude" ? "projects" : "sessions"));
  }
  if (provider === "claude") {
    const subdirectories = async (dir: string) => {
      try {
        return (await fs.readdir(dir, { withFileTypes: true }))
          .filter((e) => e.isDirectory() && !e.name.startsWith("."))
          .map((e) => path.join(dir, e.name));
      } catch {
        return [];
      }
    };
    const base = path.join(home, "Library/Application Support/Claude/local-agent-mode-sessions");
    for (const group of await subdirectories(base))
      for (const sub of await subdirectories(group)) {
        const sessions = await subdirectories(sub);
        for (const holder of [...sessions])
          if (path.basename(holder) === "agent") sessions.push(...(await subdirectories(holder)));
        for (const session of sessions) await add(path.join(session, ".claude/projects"));
      }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
  return { files, identity: `home=${home}\nroots=${identity}`, partial };
}
