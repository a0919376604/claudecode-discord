import { getConfig } from "../utils/config.js";
import { execFileSync } from "node:child_process";
import os from "node:os";

const KEYCHAIN_SERVICE = "Claude Code-credentials";
// OAuth refresh endpoint and client identifier used by the official
// Claude Code CLI. CLIENT_ID is a *public* OAuth client identifier
// (not a secret) — it identifies the Claude Code client to Anthropic's
// authorization server. Extracted from the bundled
// @anthropic-ai/claude-agent-sdk source. If Anthropic ever rotates
// either value, this module must be updated to match.
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
// Anthropic gates the OAuth refresh endpoint behind this beta header.
// Without it the endpoint returns HTTP 400 even with a valid
// refresh_token, which we then mis-diagnose as a revoked token and
// prompt the user to re-login. The official SDK sends this header on
// every refresh (see `anthropic-beta` in
// `@anthropic-ai/claude-agent-sdk/sdk.mjs`). Keep this value in sync
// with the SDK if Anthropic rolls the beta version.
const ANTHROPIC_BETA = "oauth-2025-04-20";
// User-Agent: identification only. Anthropic doesn't gate on this,
// but the official SDK always sends one. We send a stable string so
// our refresh requests are recognizable in Anthropic-side logs.
const USER_AGENT = "claudecode-discord/1.3.0";

interface RefreshResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

interface KeychainCreds {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // ms epoch
  scopes: string[];
  subscriptionType: string;
  rateLimitTier?: string;
}

interface KeychainRecord {
  creds: KeychainCreds;
  account: string;
}

function readKeychain(): KeychainRecord | null {
  let raw: string;
  try {
    raw = execFileSync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  } catch (e) {
    console.warn(
      "[credentials-refresher] Keychain entry not found or unreadable:",
      e instanceof Error ? e.message.slice(0, 200) : e,
    );
    return null;
  }

  let parsed: { claudeAiOauth?: Partial<KeychainCreds> };
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("[credentials-refresher] Keychain JSON malformed; ignoring.");
    return null;
  }

  const c = parsed.claudeAiOauth;
  if (
    !c ||
    typeof c.accessToken !== "string" ||
    typeof c.refreshToken !== "string" ||
    typeof c.expiresAt !== "number" ||
    !Array.isArray(c.scopes) ||
    typeof c.subscriptionType !== "string"
  ) {
    console.warn("[credentials-refresher] Keychain payload missing required fields.");
    return null;
  }

  // Account name is the macOS username, looked up via os.userInfo()
  // (matches the official CLI). os.userInfo() throws if there is no
  // user — which is the right semantics here, since we can't refresh
  // credentials for nobody. Wrap so we degrade gracefully rather than
  // crash if it ever fires.
  let account: string;
  try {
    account = os.userInfo().username;
  } catch (e) {
    console.warn(
      "[credentials-refresher] Could not determine current user:",
      e instanceof Error ? e.message : e,
    );
    return null;
  }
  return {
    creds: {
      accessToken: c.accessToken,
      refreshToken: c.refreshToken,
      expiresAt: c.expiresAt,
      scopes: c.scopes,
      subscriptionType: c.subscriptionType,
      rateLimitTier: c.rateLimitTier,
    },
    account,
  };
}

let inFlight: Promise<void> | null = null;

/**
 * Ensure Keychain holds a non-expired Claude Code OAuth access token
 * before the caller spawns a `claude` subprocess. Idempotent: cheap
 * (no HTTP) when the token is still fresh, self-deduplicating when
 * called concurrently.
 *
 * Never throws. Failures log and return — callers must not branch on
 * the outcome. If refresh fails, the existing auth-error path in
 * session-manager surfaces the problem to the user via Discord.
 *
 * macOS-only for v1; silently no-ops on other platforms.
 */
export async function ensureFreshCredentials(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      await doRefresh();
    } catch (e) {
      console.warn(
        "[credentials-refresher] Unexpected error:",
        e instanceof Error ? e.message : e,
      );
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

function needsRefresh(
  creds: KeychainCreds,
  thresholdMin: number,
  now: number = Date.now(),
): boolean {
  return creds.expiresAt - now < thresholdMin * 60_000;
}

async function callRefreshEndpoint(refreshToken: string): Promise<RefreshResponse | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "anthropic-beta": ANTHROPIC_BETA,
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: CLIENT_ID,
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (e) {
      console.warn(
        "[credentials-refresher] Network error on refresh:",
        e instanceof Error ? e.message : e,
      );
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      return null;
    }

    if (res.status === 401 || res.status === 400) {
      console.warn(
        `[credentials-refresher] Refresh rejected (${res.status}); refresh token likely revoked or expired. Discord will prompt user to re-login on next auth error.`,
      );
      return null;
    }
    if (res.status >= 500) {
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      console.warn(`[credentials-refresher] Refresh endpoint ${res.status} after retry; giving up.`);
      return null;
    }
    if (!res.ok) {
      console.warn(`[credentials-refresher] Unexpected status ${res.status} from refresh endpoint.`);
      return null;
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      console.warn("[credentials-refresher] Refresh response was not valid JSON.");
      return null;
    }
    const b = body as Partial<RefreshResponse>;
    if (typeof b.access_token !== "string" || typeof b.expires_in !== "number") {
      console.warn("[credentials-refresher] Refresh response missing required fields.");
      return null;
    }
    return {
      access_token: b.access_token,
      refresh_token: typeof b.refresh_token === "string" ? b.refresh_token : undefined,
      expires_in: b.expires_in,
    };
  }
  return null;
}

function writeKeychain(creds: KeychainCreds, account: string): boolean {
  const payload = JSON.stringify({ claudeAiOauth: creds });
  try {
    execFileSync(
      "security",
      [
        "add-generic-password",
        "-s", KEYCHAIN_SERVICE,
        "-a", account,
        "-w", payload,
        "-U",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    return true;
  } catch (e) {
    console.warn(
      "[credentials-refresher] Failed to write Keychain:",
      e instanceof Error ? e.message.slice(0, 200) : e,
    );
    return false;
  }
}

async function doRefresh(): Promise<void> {
  const cfg = getConfig();
  if (!cfg.CLAUDE_AUTO_REFRESH) return;
  if (process.platform !== "darwin") return;

  const keychain = readKeychain();
  if (!keychain) return;

  if (!needsRefresh(keychain.creds, cfg.CLAUDE_REFRESH_THRESHOLD_MIN)) return;

  const fresh = await callRefreshEndpoint(keychain.creds.refreshToken);
  if (!fresh) return;

  const merged: KeychainCreds = {
    ...keychain.creds,
    accessToken: fresh.access_token,
    refreshToken: fresh.refresh_token ?? keychain.creds.refreshToken,
    expiresAt: Date.now() + fresh.expires_in * 1000,
  };

  if (writeKeychain(merged, keychain.account)) {
    const hoursLeft = Math.round((merged.expiresAt - Date.now()) / 3_600_000);
    console.log(`[credentials-refresher] Refreshed access token (valid ~${hoursLeft}h).`);
  }
}
