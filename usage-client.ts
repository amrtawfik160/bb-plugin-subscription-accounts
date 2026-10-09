// Provider request shapes researched from robinebers/openusage (MIT).
// Keep provider responses and credential-bearing errors on the server.
import { jwtClaims, type PoolProviderId, type SwapProviderId } from "./providers.js";
import { fetchCursorHistory } from "./cursor-history.js";
import type { GoogleClient } from "./antigravity-client.js";
import type { ModelPricing } from "./pricing.js";
import { emptyHistory } from "./history.js";
import {
  mapAntigravity,
  mapAntigravityModelQuotas,
  mapClaude,
  mapCodex,
  mapCursor,
  mapGrok,
  number,
  object,
  textValue,
  UsageError,
  type UsageData,
} from "./usage.js";

type Json = Record<string, unknown>;
type Request = (url: string, init: RequestInit) => Promise<Json>;

class HttpError extends UsageError {
  constructor(readonly status: number) {
    super(
      status === 401 || status === 403
        ? "Usage access expired or was denied. Sign in again, then refresh."
        : `Usage request failed (HTTP ${status}). Refresh to try again.`,
    );
  }
}

function createResponseRequest(fetcher: typeof fetch, signal?: AbortSignal) {
  return async (url: string, init: RequestInit): Promise<Response> => {
    let response: Response;
    try {
      const timeout = AbortSignal.timeout(12_000);
      response = await fetcher(url, {
        ...init,
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      throw new UsageError("Could not reach the usage service. Refresh to try again.");
    }
    return response;
  };
}

function createRequest(fetcher: typeof fetch, signal?: AbortSignal): Request {
  const request = createResponseRequest(fetcher, signal);
  return async (url, init) => {
    const response = await request(url, init);
    if (!response.ok) throw new HttpError(response.status);
    try {
      return object(await response.json());
    } catch {
      throw new UsageError("The usage service returned an invalid response. Refresh to try again.");
    }
  };
}

export interface LocalCredentialStore {
  reload?: () => Promise<string | null>;
  save?: (updated: string, expected: string) => Promise<boolean>;
  expectedAccountId?: string;
}

// Port of OpenUsage's ProviderAuthRetry and Claude/Codex usage clients.
export function createLocalUsageClient(
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
) {
  const request = createResponseRequest(fetcher, signal);
  return async (
    provider: PoolProviderId,
    body: string,
    store: LocalCredentialStore = {},
  ): Promise<UsageData> => {
    let file: Json;
    function parse(value: string): Json {
      try {
        return object(JSON.parse(value));
      } catch {
      throw new UsageError("The machine login is invalid. Sign in again.");
    }
    }
    file = parse(body);
    const credentials = () =>
      object(provider === "claude" ? file.claudeAiOauth : file.tokens);
    const accessToken = () =>
      textValue(
        credentials()[provider === "claude" ? "accessToken" : "access_token"],
      );
    async function attempt(): Promise<Response> {
      const access = accessToken();
      if (!access)
      throw new UsageError("No access token for the machine login. Run the CLI to refresh its login.");
      const headers: Record<string, string> = {
      Authorization: `Bearer ${access}`,
      Accept: "application/json",
    };
      if (provider === "claude") {
        headers["anthropic-beta"] = "oauth-2025-04-20";
        headers["Content-Type"] = "application/json";
        headers["User-Agent"] = "claude-cli/2.1.280 (external, cli)";
      } else {
        headers["User-Agent"] = "OpenUsage";
        const tokens = credentials();
        const claims = object(jwtClaims(tokens.id_token ?? access)?.["https://api.openai.com/auth"]);
        const account = textValue(tokens.account_id ?? claims.chatgpt_account_id);
        if (account) headers["ChatGPT-Account-Id"] = account;
      }
      return request(
        provider === "claude"
          ? "https://api.anthropic.com/api/oauth/usage?cedar_ember=1"
          : "https://chatgpt.com/backend-api/wham/usage",
        { headers },
      );
    }
    async function refresh(): Promise<void> {
      const token = textValue(
        credentials()[provider === "claude" ? "refreshToken" : "refresh_token"],
      );
      if (!token)
        throw new UsageError(
          "The machine login cannot refresh. Sign in again.",
        );
      // Refresh tokens rotate: never consume one without a way to persist its replacement.
      if (!store.save)
        throw new UsageError(
          "Run the CLI to refresh its login, then refresh usage.",
        );
      const claude = provider === "claude";
      const payload = claude
        ? JSON.stringify({
            grant_type: "refresh_token",
            refresh_token: token,
            client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
            scope:
              "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
          })
        : new URLSearchParams({
            grant_type: "refresh_token",
            client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
            refresh_token: token,
          }).toString();
      const response = await request(
        claude
          ? "https://platform.claude.com/v1/oauth/token"
          : "https://auth.openai.com/oauth/token",
        {
          method: "POST",
          headers: {
            "Content-Type": claude
              ? "application/json"
              : "application/x-www-form-urlencoded",
          },
          body: payload,
        },
      );
      const result = object(await response.json().catch(() => null));
      if (!response.ok) {
        const code = textValue(
          object(result.error).code ?? result.error ?? result.code,
        );
        const expired = [
          "invalid_grant",
          "refresh_token_expired",
          "refresh_token_reused",
          "refresh_token_invalidated",
        ].includes(code ?? "");
        throw new UsageError(
          expired
            ? "The CLI session expired or its refresh token was replaced. Sign in again."
            : `OAuth refresh failed (HTTP ${response.status}). Refresh to try again.`,
        );
      }
      const access = textValue(result.access_token);
      if (!access)
        throw new UsageError(
          "The provider returned no refreshed access token. Sign in again.",
        );
      const tokens = credentials();
      tokens[claude ? "accessToken" : "access_token"] = access;
      if (textValue(result.refresh_token))
        tokens[claude ? "refreshToken" : "refresh_token"] =
          result.refresh_token;
      if (textValue(result.id_token)) tokens.id_token = result.id_token;
      const expires = number(result.expires_in);
      if (claude && expires !== null)
        tokens.expiresAt = Date.now() + expires * 1000;
      if (!claude) file.last_refresh = new Date().toISOString();
      if (!(await store.save(JSON.stringify(file), body)))
        throw new UsageError(
          "The CLI login changed during refresh. Refresh again.",
        );
    }
    let response = await attempt();
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      const current = await store.reload?.();
      if (current && current !== body) {
        body = current;
        file = parse(current);
      } else await refresh();
      response = await attempt();
    }
    if (!response.ok) throw new HttpError(response.status);
    if (store.expectedAccountId) {
      if (provider === "claude") {
        const profile = await request(
          "https://api.anthropic.com/api/oauth/profile",
          {
            headers: {
              Authorization: `Bearer ${accessToken()}`,
              Accept: "application/json",
              "anthropic-beta": "oauth-2025-04-20",
            },
          },
        );
        if (!profile.ok) throw new HttpError(profile.status);
        const identity = object(await profile.json().catch(() => null));
        if (
          textValue(object(identity.account).uuid) !== store.expectedAccountId
        )
          throw new UsageError(
            "The CLI login belongs to another account. Sign in to the saved account again.",
          );
      } else {
        const tokens = credentials();
        const claims = object(
          jwtClaims(tokens.id_token ?? accessToken())?.[
            "https://api.openai.com/auth"
          ],
        );
        if (
          textValue(tokens.account_id ?? claims.chatgpt_account_id) !==
          store.expectedAccountId
        )
          throw new UsageError(
            "The CLI login belongs to another account. Sign in to the saved account again.",
          );
      }
    }
    let result: Json;
    try {
      result = object(await response.json());
    } catch {
      throw new UsageError("The usage service returned an invalid response. Refresh to try again.");
    }
    return provider === "claude"
      ? mapClaude(result)
      : mapCodex(result, Date.now(), response.headers);
  };
}

function sameClient(a: GoogleClient, b: GoogleClient | null): boolean {
  return Boolean(b && a.clientId === b.clientId && a.clientSecret === b.clientSecret);
}

// OpenUsage's CursorSession selects the second subject component when present.
function cursorUserId(access: string): string | null {
  const subject = textValue(jwtClaims(access)?.sub);
  if (!subject) return null;
  const parts = subject.split("|");
  return (parts.length > 1 ? parts[1] : parts[0]) || null;
}

export function createUsageClient(
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
  googleOAuthClients: () => Promise<GoogleClient[]> = async () => [],
  pricing?: () => Promise<ModelPricing>,
) {
  const request = createRequest(fetcher, signal);
  const respond = createResponseRequest(fetcher, signal);
  // The client that last renewed an Antigravity login; tried first next time.
  let googleClient: GoogleClient | null = null;
  const bearer = (token: string): Record<string, string> => ({
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  });
  const optional = (task: Promise<Json>): Promise<Json | null> => task.catch(() => null);

  return async function fetchUsage(
    provider: SwapProviderId,
    body: string,
    save: (updated: string) => Promise<void>,
  ): Promise<UsageData> {
    let file: Json;
    try {
      file = object(JSON.parse(body));
    } catch {
      throw new UsageError("The saved login is invalid. Sign in again.");
    }
    const entryPair =
      provider === "grok"
        ? Object.entries(file).find(([, value]) => textValue(object(value).refresh_token) !== null)
        : undefined;
    const credentials =
      provider === "antigravity" ? object(file.token) : provider === "grok" ? object(entryPair?.[1]) : file;
    const accessKey = provider === "cursor" ? "accessToken" : provider === "grok" ? "key" : "access_token";
    const refreshKey = provider === "cursor" ? "refreshToken" : "refresh_token";
    let access = textValue(credentials[accessKey]);

    async function refresh(): Promise<void> {
      const refreshToken = textValue(credentials[refreshKey]);
      if (!refreshToken) throw new UsageError("The saved login cannot refresh. Sign in again.");
      let result: Json;
      if (provider === "cursor") {
        result = await request("https://api2.cursor.sh/oauth/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "refresh_token",
            client_id: "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB",
            refresh_token: refreshToken,
          }),
        });
      } else if (provider === "antigravity") {
        result = await refreshGoogle(refreshToken);
      } else {
        const params = new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id:
            textValue(credentials.oidc_client_id) ??
            entryPair?.[0].split("::").pop() ??
            "b1a00492-073a-47ea-816f-4c329264a828",
        });
        result = await request("https://auth.x.ai/oauth2/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: params.toString(),
        });
      }
      access = textValue(result.access_token);
      if (!access) throw new UsageError("The provider could not refresh this login. Sign in again.");
      credentials[accessKey] = access;
      if (textValue(result.refresh_token)) credentials[refreshKey] = result.refresh_token;
      if (textValue(result.id_token)) credentials.id_token = result.id_token;
      const expires = number(result.expires_in);
      if (expires !== null) {
        // agy reads Go's oauth2 "expiry" (RFC 3339), not a millisecond field.
        if (provider === "antigravity") credentials.expiry = new Date(Date.now() + expires * 1000).toISOString();
        if (provider === "grok") credentials.expires_at = new Date(Date.now() + expires * 1000).toISOString();
      }
      await save(JSON.stringify(file));
    }

    // Google answers invalid_client for a wrong client before it checks the
    // refresh token, so each candidate pair can be tried safely in turn.
    async function refreshGoogle(refreshToken: string): Promise<Json> {
      const audience = textValue(jwtClaims(file.id_token)?.aud);
      const candidates = [...(await googleOAuthClients())].sort(
        (a, b) =>
          Number(sameClient(b, googleClient)) - Number(sameClient(a, googleClient)) ||
          Number(b.clientId === audience) - Number(a.clientId === audience),
      );
      if (candidates.length === 0)
        throw new UsageError(
          "Could not renew this Antigravity login: the agy CLI was not found on this machine. Install agy, then refresh.",
        );
      for (const client of candidates) {
        const response = await respond("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id: client.clientId,
            client_secret: client.clientSecret,
          }).toString(),
        });
        const body = object(await response.json().catch(() => null));
        if (response.ok) {
          googleClient = client;
          return body;
        }
        const code = textValue(body.error);
        if (code === "invalid_client" || code === "unauthorized_client") continue;
        if (code === "invalid_grant")
          throw new UsageError("Google signed this Antigravity account out. Sign in again.");
        throw new UsageError(`Antigravity login renewal failed (HTTP ${response.status}). Refresh to try again.`);
      }
      throw new UsageError(
        "Could not renew this Antigravity login with the installed agy CLI. Update agy, then refresh.",
      );
    }

    async function load(): Promise<UsageData> {
      if (!access) throw new HttpError(401);
      if (provider === "grok") {
        const headers = {
          ...bearer(access),
          "X-XAI-Token-Auth": "xai-grok-cli",
        };
        const [billing, settings] = await Promise.all([
          request("https://cli-chat-proxy.grok.com/v1/billing?format=credits", {
            headers,
          }),
          optional(request("https://cli-chat-proxy.grok.com/v1/settings", { headers })),
        ]);
        return {
          plan: textValue(settings?.subscription_tier_display),
          metrics: mapGrok(billing),
        };
      }
      if (provider === "cursor") {
        const headers = { ...bearer(access), "Connect-Protocol-Version": "1" };
        const post = (method: string) =>
          request(`https://api2.cursor.sh/aiserver.v1.DashboardService/${method}`, {
            method: "POST",
            headers,
            body: "{}",
          });
        let usage: Json | null;
        try {
          usage = await post("GetCurrentPeriodUsage");
        } catch (cause) {
          if (cause instanceof HttpError && [401, 403].includes(cause.status)) throw cause;
          usage = null;
        }
        const [plan, credits] = await Promise.all([
          optional(post("GetPlanInfo")),
          optional(post("GetCreditGrantsBalance")),
        ]);
        let mapped = mapCursor(usage, null, null, credits);
        if (!mapped.metrics.some((row) => row.label === "Plan usage" || row.label === "Included requests")) {
          const user = cursorUserId(access);
          if (user) {
            const cookieHeaders = {
              Cookie: `WorkosCursorSessionToken=${encodeURIComponent(user)}%3A%3A${access}`,
            };
            const [summary, requests] = await Promise.all([
              optional(
                request("https://cursor.com/api/usage-summary", {
                  headers: cookieHeaders,
                }),
              ),
              optional(
                request(`https://cursor.com/api/usage?user=${encodeURIComponent(user)}`, {
                  headers: cookieHeaders,
                }),
              ),
            ]);
            mapped = mapCursor(usage, summary, requests, credits);
          }
        }
        const historyUser = cursorUserId(access);
        return {
          ...mapped,
          plan: textValue(plan?.planName ?? plan?.plan ?? object(plan?.planInfo).planName) ?? mapped.plan,
          history: historyUser
            ? await fetchCursorHistory(
                fetcher,
                `WorkosCursorSessionToken=${encodeURIComponent(historyUser)}%3A%3A${access}`,
                signal,
                pricing,
              )
            : {
                ...emptyHistory("cursor"),
                status: "error",
                fetchedAt: Date.now(),
                error: "This login does not provide access to Cursor’s usage export.",
              },
        };
      }
      const cloud = async (method: string): Promise<Json> => {
        let last: unknown;
        for (const base of [
          "https://daily-cloudcode-pa.googleapis.com",
          "https://cloudcode-pa.googleapis.com",
        ]) {
          try {
            return await request(`${base}/v1internal:${method}`, {
              method: "POST",
              headers: { ...bearer(access!), "User-Agent": "antigravity" },
              body: "{}",
            });
          } catch (cause) {
            if (cause instanceof HttpError && [401, 403].includes(cause.status)) throw cause;
            last = cause;
          }
        }
        throw last;
      };
      let summary: Json | null = null;
      try {
        summary = await cloud("retrieveUserQuotaSummary");
      } catch (cause) {
        if (cause instanceof HttpError && [401, 403].includes(cause.status)) throw cause;
      }
      const hasSummary = Array.isArray(summary?.groups) || Array.isArray(object(summary?.response).groups);
      const [models, plan] = await Promise.all([
        hasSummary ? optional(cloud("fetchAvailableModels")) : cloud("fetchAvailableModels"),
        optional(cloud("loadCodeAssist")),
      ]);
      return {
        plan: textValue(object(plan?.paidTier).name ?? object(plan?.currentTier).name),
        metrics: mapAntigravity(summary, models),
        modelQuotas: mapAntigravityModelQuotas(models),
      };
    }

    const exp = number(jwtClaims(access)?.exp);
    let refreshed = false;
    if (!access || (exp !== null && exp * 1000 <= Date.now() + 60_000)) {
      await refresh();
      refreshed = true;
    }
    try {
      return await load();
    } catch (cause) {
      if (!refreshed && cause instanceof HttpError && [401, 403].includes(cause.status)) {
        await refresh();
        return load();
      }
      throw cause;
    }
  };
}
