// agy is a Google "installed app": its OAuth client ID and secret ship inside
// the binary. Saved logins need that client to renew their one-hour access
// token, so read it from the CLI on this machine instead of asking the user.

import { createReadStream } from "node:fs";
import fs from "node:fs/promises";

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
}

const CLIENT_ID = /\d{6,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com/g;
// Go packs string constants back to back, so a secret has no terminator.
const CLIENT_SECRET = /GOCSPX-[A-Za-z0-9_-]{28}/g;
/** Longest match plus slack, kept between chunks so a split string is still found. */
const OVERLAP = 128;

export async function scanClients(file: string): Promise<{ ids: string[]; secrets: string[] }> {
  const ids = new Set<string>();
  const secrets = new Set<string>();
  let tail = "";
  for await (const chunk of createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })) {
    const text = tail + (chunk as Buffer).toString("latin1");
    for (const match of text.matchAll(CLIENT_ID)) ids.add(match[0]);
    for (const match of text.matchAll(CLIENT_SECRET)) secrets.add(match[0]);
    tail = text.slice(-OVERLAP);
  }
  return { ids: [...ids], secrets: [...secrets] };
}

/** Every ID/secret pair found in the binary, cached until the binary changes. */
export function antigravityClients(findBinary: () => Promise<string | null>) {
  let cached: { stamp: string; clients: GoogleClient[] } | null = null;
  return async (): Promise<GoogleClient[]> => {
    const binary = await findBinary();
    if (!binary) return [];
    const stat = await fs.stat(binary).catch(() => null);
    if (!stat) return [];
    const stamp = `${binary}:${stat.size}:${stat.mtimeMs}`;
    if (cached?.stamp !== stamp) {
      const { ids, secrets } = await scanClients(binary).catch(() => ({ ids: [], secrets: [] }));
      cached = {
        stamp,
        clients: ids.flatMap((clientId) => secrets.map((clientSecret) => ({ clientId, clientSecret }))),
      };
    }
    return cached.clients;
  };
}
