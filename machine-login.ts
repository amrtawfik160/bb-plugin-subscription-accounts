import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PoolAccount } from "./pooler.js";
import { jwtClaims } from "./providers.js";

const oauthSchema = z.object({
  kind: z.literal("oauth"),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number().nullable().optional(),
  idToken: z.string().nullable().optional(),
});

// BB 0.44 stores OAuth secrets here. Keep this compatibility boundary server-only.
export async function machineCredentials(dataDir: string, account: PoolAccount) {
  if (!/^[a-zA-Z0-9_-]+$/.test(account.id) || account.kind !== "oauth") {
    throw new Error("Only saved subscription accounts can be used on this machine.");
  }
  let secret: z.infer<typeof oauthSchema>;
  try {
    const file = path.join(dataDir, "plugins/account-pool/secrets/accounts", `account-${account.id}.json`);
    secret = oauthSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
  } catch {
    throw new Error("The saved login is unavailable. Sign in to this account again.");
  }
  if (account.provider === "codex") {
    const claims = jwtClaims(secret.idToken)?.["https://api.openai.com/auth"] as
      { chatgpt_account_id?: unknown } | undefined;
    if (!account.codexAccountId || (claims?.chatgpt_account_id && claims.chatgpt_account_id !== account.codexAccountId)) {
      throw new Error("The saved login identity does not match this account. Sign in again.");
    }
    return JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        access_token: secret.accessToken,
        refresh_token: secret.refreshToken,
        id_token: secret.idToken ?? null,
        account_id: account.codexAccountId,
      },
      last_refresh: new Date().toISOString(),
    });
  }
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: secret.accessToken,
      refreshToken: secret.refreshToken,
      expiresAt: secret.expiresAt ?? 0,
      scopes: ["user:inference", "user:profile", "user:sessions:claude_code", "user:mcp_servers"],
      subscriptionType: account.subscriptionType ?? null,
      rateLimitTier: account.rateLimitTier ?? null,
    },
  });
}

export async function readLoginFile(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Could not read the machine login. Check file permissions.");
  }
}

export async function replaceLoginFiles(files: { path: string; before: string | null; after: string }[]) {
  const staged = files.map((file) => ({ ...file, temp: `${file.path}.${randomUUID()}.switch` }));
  const written: typeof staged = [];
  try {
    for (const file of staged) {
      await fs.mkdir(path.dirname(file.path), { recursive: true, mode: 0o700 });
      await fs.writeFile(file.temp, file.after, { mode: 0o600, flag: "wx" });
    }
    for (const file of staged) {
      if (await readLoginFile(file.path) !== file.before) {
        throw new Error("The machine login changed during switching. Refresh and try again.");
      }
    }
    for (const file of staged) {
      if (await readLoginFile(file.path) !== file.before) {
        throw new Error("The machine login changed during switching. Refresh and try again.");
      }
      await fs.rename(file.temp, file.path);
      written.push(file);
    }
  } catch (error) {
    for (const file of written.reverse()) {
      if (await readLoginFile(file.path) !== file.after) continue;
      if (file.before === null) await fs.rm(file.path, { force: true });
      else {
        await fs.writeFile(file.temp, file.before, { mode: 0o600 });
        await fs.rename(file.temp, file.path);
      }
    }
    throw error;
  } finally {
    await Promise.all(staged.map((file) => fs.rm(file.temp, { force: true })));
  }
}
