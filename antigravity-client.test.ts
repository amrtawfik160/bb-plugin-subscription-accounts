import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { antigravityClients, scanClients } from "./antigravity-client";
import { createUsageClient } from "./usage-client";

const ID = "123456789012-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com";
const SECRET_A = `GOCSPX-${"a".repeat(28)}`;
const SECRET_B = `GOCSPX-${"b".repeat(28)}`;

describe("Antigravity OAuth client discovery", () => {
  it("finds client IDs and secrets, including ones split across read chunks", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-"));
    const file = path.join(dir, "agy");
    const pad = Buffer.alloc(4 * 1024 * 1024 - 10, 0);
    await fs.writeFile(file, Buffer.concat([pad, Buffer.from(`\0${ID}\0${SECRET_A}${SECRET_B}\0`)]));
    const found = await scanClients(file);
    expect(found.ids).toEqual([ID]);
    expect(found.secrets).toEqual([SECRET_A, SECRET_B]);
    const clients = await antigravityClients(async () => file)();
    expect(clients).toEqual([
      { clientId: ID, clientSecret: SECRET_A },
      { clientId: ID, clientSecret: SECRET_B },
    ]);
    await fs.rm(dir, { recursive: true });
  });

  it("renews an expired saved login with the first client Google accepts", async () => {
    const body = JSON.stringify({
      token: { access_token: "", refresh_token: "refresh", expiry: "2020-01-01T00:00:00Z" },
    });
    const secrets: string[] = [];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://oauth2.googleapis.com/token") {
        const secret = new URLSearchParams(String(init?.body)).get("client_secret")!;
        secrets.push(secret);
        return secret === SECRET_B
          ? Response.json({ access_token: "fresh", expires_in: 3599 })
          : Response.json({ error: "invalid_client" }, { status: 401 });
      }
      return Response.json({ groups: [] });
    });
    const save = vi.fn(async () => undefined);
    const fetchUsage = createUsageClient(fetcher as typeof fetch, undefined, async () => [
      { clientId: ID, clientSecret: SECRET_A },
      { clientId: ID, clientSecret: SECRET_B },
    ]);
    await fetchUsage("antigravity", body, save);
    expect(secrets).toEqual([SECRET_A, SECRET_B]);
    const saved = JSON.parse((save.mock.calls[0] as unknown as [string])[0]);
    expect(saved.token.access_token).toBe("fresh");
    expect(Date.parse(saved.token.expiry)).toBeGreaterThan(Date.now());

    // The working client is remembered and tried first.
    secrets.length = 0;
    await fetchUsage("antigravity", body, save);
    expect(secrets).toEqual([SECRET_B]);
  });

  it("reports a revoked login as signed out", async () => {
    const fetcher = vi.fn(async () => Response.json({ error: "invalid_grant" }, { status: 400 }));
    const fetchUsage = createUsageClient(fetcher as typeof fetch, undefined, async () => [
      { clientId: ID, clientSecret: SECRET_A },
    ]);
    await expect(
      fetchUsage("antigravity", JSON.stringify({ token: { refresh_token: "r" } }), async () => undefined),
    ).rejects.toThrow(/Sign in again/);
  });
});
