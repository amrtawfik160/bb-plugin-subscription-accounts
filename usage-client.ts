// Provider request shapes researched from robinebers/openusage (MIT).
// Keep provider responses and credential-bearing errors on the server.
import { jwtClaims, type PoolProviderId, type SwapProviderId } from "./providers.js";
import { fetchCursorHistory } from "./cursor-history.js";
import { emptyHistory } from "./history.js";
import {
  mapAntigravity,
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

function createRequest(fetcher: typeof fetch, signal?: AbortSignal): Request {
  return async (url, init) => {
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
    if (!response.ok) throw new HttpError(response.status);
    try {
      return object(await response.json());
    } catch {
      throw new UsageError("The usage service returned an invalid response. Refresh to try again.");
    }
  };
}

export function createLocalUsageClient(fetcher: typeof fetch = fetch, signal?: AbortSignal) {
  const request = createRequest(fetcher, signal);
  return async (provider: PoolProviderId, body: string): Promise<UsageData> => {
    let file: Json;
    try {
      file = object(JSON.parse(body));
    } catch {
      throw new UsageError("The machine login is invalid. Sign in again.");
    }
    const tokens = object(provider === "claude" ? file.claudeAiOauth : file.tokens);
    const access = textValue(provider === "claude" ? tokens.accessToken : tokens.access_token);
    if (!access)
      throw new UsageError("No access token for the machine login. Run the CLI to refresh its login.");
    const headers: Record<string, string> = {
      Authorization: `Bearer ${access}`,
      Accept: "application/json",
    };
    if (provider === "claude") {
      headers["anthropic-beta"] = "oauth-2025-04-20";
      return mapClaude(await request("https://api.anthropic.com/api/oauth/usage", { headers }));
    }
    const claims = object(jwtClaims(tokens.id_token ?? access)?.["https://api.openai.com/auth"]);
    const account = textValue(tokens.account_id ?? claims.chatgpt_account_id);
    if (account) headers["ChatGPT-Account-Id"] = account;
    return mapCodex(await request("https://chatgpt.com/backend-api/wham/usage", { headers }));
  };
}

export function createUsageClient(
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
  googleOAuthClient: () => Promise<{ clientId: string; clientSecret: string } | null> = async () => null,
) {
  const request = createRequest(fetcher, signal);
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
      } else {
        const google = provider === "antigravity" ? await googleOAuthClient() : null;
        if (provider === "antigravity" && !google)
          throw new UsageError(
            "Antigravity login expired. Refresh the CLI login or configure its OAuth client in plugin settings.",
          );
        const params = new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id:
            provider === "antigravity"
              ? google!.clientId
              : (textValue(credentials.oidc_client_id) ??
                entryPair?.[0].split("::").pop() ??
                "b1a00492-073a-47ea-816f-4c329264a828"),
        });
        if (provider === "antigravity") params.set("client_secret", google!.clientSecret);
        result = await request(
          provider === "antigravity"
            ? "https://oauth2.googleapis.com/token"
            : "https://auth.x.ai/oauth2/token",
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: params.toString(),
          },
        );
      }
      access = textValue(result.access_token);
      if (!access) throw new UsageError("The provider could not refresh this login. Sign in again.");
      credentials[accessKey] = access;
      if (textValue(result.refresh_token)) credentials[refreshKey] = result.refresh_token;
      if (textValue(result.id_token)) credentials.id_token = result.id_token;
      const expires = number(result.expires_in);
      if (expires !== null) {
        if (provider === "antigravity") credentials.expiry_date = Date.now() + expires * 1000;
        if (provider === "grok") credentials.expires_at = new Date(Date.now() + expires * 1000).toISOString();
      }
      await save(JSON.stringify(file));
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
          const subject = textValue(jwtClaims(access)?.sub);
          const user = subject?.split("|").pop();
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
        const historyUser = textValue(jwtClaims(access)?.sub)?.split("|").pop();
        return {
          ...mapped,
          plan: textValue(plan?.planName ?? plan?.plan ?? object(plan?.planInfo).planName) ?? mapped.plan,
          history: historyUser
            ? await fetchCursorHistory(
                fetcher,
                `WorkosCursorSessionToken=${encodeURIComponent(historyUser)}%3A%3A${access}`,
                signal,
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
        hasSummary ? Promise.resolve(null) : cloud("fetchAvailableModels"),
        optional(cloud("loadCodeAssist")),
      ]);
      return {
        plan: textValue(object(plan?.paidTier).name ?? object(plan?.currentTier).name),
        metrics: mapAntigravity(summary, models),
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
