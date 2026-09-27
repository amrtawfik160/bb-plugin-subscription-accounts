// What each subscription looks like on disk and in bb.
//
// "swap" providers keep their login in one file under HOME. This plugin saves
// copies of that file and swaps them in. Claude Code and Codex are "pool"
// providers: bb's builtin Account Pooler routes their traffic instead, so they
// are described in pooler.ts, not here.

export type SwapProviderId = "antigravity" | "cursor" | "grok";
export type PoolProviderId = "claude" | "codex";
export type ProviderId = SwapProviderId | PoolProviderId;

export interface Identity {
  /** Stable per-account key: the email when the file carries one. */
  key: string;
  email: string | null;
}

export interface LoginSpec {
  binary: string;
  args: string[];
  env?: Record<string, string>;
  /** agy wants the Google code pasted back; the others poll the browser. */
  needsCode: boolean;
  urlPattern: RegExp;
  /** Device-code flows show a short code the user confirms in the browser. */
  userCodePattern?: RegExp;
  /** How long the CLI waits for the user before giving up. */
  windowMs: number;
}

export interface SwapProvider {
  id: SwapProviderId;
  label: string;
  /** bb provider ids whose threads run on this login. */
  bbProviderIds: string[];
  /** Login file, relative to HOME. */
  tokenPath: string;
  login: LoginSpec;
  /** Throws when the file is not a usable login. */
  identify(body: string): Identity;
  quota: RegExp;
  /** CLI that reports the signed-in email when the login file does not. */
  whoami?: { binary: string; args: string[]; pattern: RegExp };
}

function json(body: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("Login file is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Login file must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

export function jwtClaims(token: unknown): Record<string, unknown> | null {
  if (typeof token !== "string") return null;
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// Messages seen from each CLI when a plan's limit is hit. The trailing
// alternatives are the generic shapes most providers use.
const GENERIC_QUOTA =
  /quota (?:reached|exceeded|exhausted)|RESOURCE_EXHAUSTED|\(code 429\)|\b429\b.*(?:limit|quota)|usage limit|rate limit(?:ed)? (?:reached|exceeded)|out of (?:credits|usage)|upgrade your (?:plan|subscription)/i;

export const SWAP_PROVIDERS: Record<SwapProviderId, SwapProvider> = {
  antigravity: {
    id: "antigravity",
    label: "Antigravity",
    bbProviderIds: ["acp-antigravity"],
    tokenPath: ".gemini/antigravity-cli/antigravity-oauth-token",
    login: {
      binary: "agy",
      args: ["-p", "Reply with OK", "--print-timeout", "90s"],
      env: { BROWSER: "/bin/true" },
      needsCode: true,
      urlPattern: /https:\/\/accounts\.google\.com\/\S+/,
      windowMs: 58_000,
    },
    // { token: { refresh_token, ... }, auth_method, id_token }
    identify(body) {
      const file = json(body);
      const token = file.token as { refresh_token?: unknown } | undefined;
      if (!str(token?.refresh_token)) throw new Error("No refresh token. Sign in to agy first.");
      const email = str(jwtClaims(file.id_token)?.email);
      return { key: email ?? String(token?.refresh_token).slice(-16), email };
    },
    quota: GENERIC_QUOTA,
  },
  cursor: {
    id: "cursor",
    label: "Cursor",
    bbProviderIds: ["acp-cursor"],
    tokenPath: ".config/cursor/auth.json",
    login: {
      binary: "cursor-agent",
      args: ["login"],
      env: { NO_OPEN_BROWSER: "1" },
      needsCode: false,
      urlPattern: /https:\/\/cursor\.com\/loginDeepControl\S+/,
      windowMs: 5 * 60_000,
    },
    // { accessToken, refreshToken } — the email is only available from `status`.
    identify(body) {
      const file = json(body);
      if (!str(file.refreshToken)) throw new Error("No refresh token. Sign in to Cursor first.");
      const sub = str(jwtClaims(file.accessToken)?.sub);
      return { key: sub ?? String(file.refreshToken).slice(-16), email: null };
    },
    whoami: { binary: "cursor-agent", args: ["status"], pattern: /Logged in as\s+(\S+@\S+)/ },
    quota: GENERIC_QUOTA,
  },
  grok: {
    id: "grok",
    label: "Grok",
    bbProviderIds: ["acp-grok"],
    tokenPath: ".grok/auth.json",
    login: {
      binary: "grok",
      args: ["login", "--device-auth"],
      needsCode: false,
      urlPattern: /https:\/\/accounts\.x\.ai\/\S+/,
      userCodePattern: /^\s*([A-Z0-9]{4}-[A-Z0-9]{4})\s*$/m,
      windowMs: 10 * 60_000,
    },
    // { "<issuer>::<client>": { email, user_id, refresh_token, ... } }
    identify(body) {
      const file = json(body);
      const entry = Object.values(file).find(
        (value): value is Record<string, unknown> =>
          typeof value === "object" && value !== null && "refresh_token" in value,
      );
      if (!entry || !str(entry.refresh_token)) throw new Error("No refresh token. Sign in to Grok first.");
      const email = str(entry.email);
      return { key: email ?? str(entry.user_id) ?? String(entry.refresh_token).slice(-16), email };
    },
    quota: GENERIC_QUOTA,
  },
};

export const SWAP_IDS = Object.keys(SWAP_PROVIDERS) as SwapProviderId[];
export const POOL_IDS: PoolProviderId[] = ["claude", "codex"];

export function isSwapId(id: string): id is SwapProviderId {
  return id in SWAP_PROVIDERS;
}

export function swapProviderForThread(bbProviderId: string | null | undefined): SwapProvider | null {
  if (!bbProviderId) return null;
  return SWAP_IDS.map((id) => SWAP_PROVIDERS[id]).find((p) => p.bbProviderIds.includes(bbProviderId)) ?? null;
}
