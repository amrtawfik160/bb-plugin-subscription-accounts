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
