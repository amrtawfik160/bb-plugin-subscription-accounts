import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "vitest";

import { LoginSession } from "./login.js";

let root: string | null = null;
afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true, maxRetries: 10 });
  root = null;
});

test("cancelling a sign-in whose CLI keeps writing after SIGTERM removes its folder without an unhandled rejection", async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "login-cleanup-"));
  const binary = path.join(root, "stubborn-cli");
  // Ignores SIGTERM and keeps filling a nested folder, like agy did on Oct 9.
  await fs.writeFile(
    binary,
    `#!/bin/sh
trap '' TERM
echo "Open https://example.test/sign-in"
mkdir -p .gemini/antigravity-cli
i=0
while true; do
  i=$((i+1))
  echo x > .gemini/antigravity-cli/f$i
done
`,
    { mode: 0o755 },
  );
  const home = path.join(root, "home");
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    let waiting!: () => void;
    const shown = new Promise<void>((resolve) => (waiting = resolve));
    const session = new LoginSession(
      "antigravity",
      { binary: "stubborn-cli", args: [], needsCode: true, urlPattern: /https:\/\/\S+/, windowMs: 60_000 },
      home,
      "token.json",
      () => {
        if (session.state.status === "waiting") waiting();
      },
      async () => "unused",
    );
    await session.start(binary);
    await shown;
    // Let it write for a while so the folder is busy when cleanup starts.
    await new Promise((resolve) => setTimeout(resolve, 200));
    session.cancel();
    await session.closed;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(rejections).toEqual([]);
    await expect(fs.access(home)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    process.off("unhandledRejection", onRejection);
  }
}, 20_000);

test("pre-creates config directories in home so CLIs requiring them can start", async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "login-dirs-"));
  const binary = path.join(root, "check-dirs-cli");
  await fs.writeFile(
    binary,
    `#!/bin/sh
[ -d "$CODEX_HOME" ] || { echo "CODEX_HOME missing" >&2; exit 1; }
[ -d "$CLAUDE_CONFIG_DIR" ] || { echo "CLAUDE_CONFIG_DIR missing" >&2; exit 1; }
echo "Open https://auth.openai.com/codex/device"
echo "ABCD-1234"
sleep 5
`,
    { mode: 0o755 },
  );
  const home = path.join(root, "home");
  let waiting!: () => void;
  const shown = new Promise<void>((resolve) => (waiting = resolve));
  const session = new LoginSession(
    "codex",
    {
      binary: "check-dirs-cli",
      args: [],
      needsCode: false,
      urlPattern: /https:\/\/auth\.openai\.com\/codex\/device\S*/,
      userCodePattern: /\b([A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})+)\b/,
      windowMs: 60_000,
    },
    home,
    ".codex/auth.json",
    () => {
      if (session.state.status === "waiting") waiting();
    },
    async () => "unused",
  );
  await session.start(binary);
  await shown;
  expect(session.state.status).toBe("waiting");
  expect(session.state.userCode).toBe("ABCD-1234");
  session.cancel();
  await session.closed;
});

test("fails immediately if the CLI exits before starting a sign-in", async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "login-fail-"));
  const binary = path.join(root, "failing-cli");
  await fs.writeFile(
    binary,
    `#!/bin/sh
echo "Error: configuration failed" >&2
exit 1
`,
    { mode: 0o755 },
  );
  const home = path.join(root, "home");
  let failed!: () => void;
  const failedPromise = new Promise<void>((resolve) => (failed = resolve));
  const session = new LoginSession(
    "codex",
    {
      binary: "failing-cli",
      args: [],
      needsCode: false,
      urlPattern: /https:\/\/auth\.openai\.com\/codex\/device\S*/,
      windowMs: 60_000,
    },
    home,
    ".codex/auth.json",
    () => {
      if (session.state.status === "failed") failed();
    },
    async () => "unused",
  );
  await session.start(binary);
  await failedPromise;
  expect(session.state.status).toBe("failed");
  expect(session.state.error).toContain("The failing-cli CLI stopped: Error: configuration failed");
  await session.closed;
});

