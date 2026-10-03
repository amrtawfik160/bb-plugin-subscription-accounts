import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { machineCredentials, replaceLoginFiles } from "./machine-login";
import type { PoolAccount } from "./pooler";

let dir: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});
const account: PoolAccount = {
  id: "new", provider: "codex", kind: "oauth", label: "New", email: null,
  enabled: true, priority: 0, status: "ready", codexAccountId: "expected",
};

describe("machine login files", () => {
  it("rejects mismatched saved identities and traversal without exposing credentials", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "machine-login-test-"));
    const secrets = path.join(dir, "plugins/account-pool/secrets/accounts");
    await fs.mkdir(secrets, { recursive: true });
    await fs.writeFile(path.join(secrets, "account-new.json"), JSON.stringify({
      kind: "oauth", accessToken: "private-access", refreshToken: "private-refresh",
      idToken: `h.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "other" } })).toString("base64url")}.s`,
    }));
    await expect(machineCredentials(dir, account)).rejects.toThrow("identity does not match");
    await expect(machineCredentials(dir, { ...account, id: "../new" })).rejects.toThrow("Only saved subscription");
    await fs.writeFile(path.join(secrets, "account-new.json"), '{"private-access":');
    await expect(machineCredentials(dir, account)).rejects.toThrow("saved login is unavailable");
  });

  it("keeps a newer machine login and cleans up staged files", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "machine-login-test-"));
    const target = path.join(dir, "auth.json");
    await fs.writeFile(target, "newer");
    await expect(replaceLoginFiles([{ path: target, before: "old", after: "chosen" }])).rejects.toThrow("changed during switching");
    expect(await fs.readFile(target, "utf8")).toBe("newer");
    expect(await fs.readdir(dir)).toEqual(["auth.json"]);
  });

  it("restores the Claude profile if replacing credentials fails", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "machine-login-test-"));
    const profile = path.join(dir, "profile.json"), auth = path.join(dir, "auth.json");
    await fs.writeFile(profile, "old-profile");
    await fs.writeFile(auth, "old-auth");
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (to === auth) throw new Error("write failed");
      return rename(from, to);
    });
    await expect(replaceLoginFiles([
      { path: profile, before: "old-profile", after: "chosen-profile" },
      { path: auth, before: "old-auth", after: "chosen-auth" },
    ])).rejects.toThrow("write failed");
    expect(await fs.readFile(profile, "utf8")).toBe("old-profile");
    expect(await fs.readFile(auth, "utf8")).toBe("old-auth");
    expect((await fs.readdir(dir)).sort()).toEqual(["auth.json", "profile.json"]);
  });
});
