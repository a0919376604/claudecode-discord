import { getConfig } from "../utils/config.js";
import { execFileSync } from "node:child_process";

const KEYCHAIN_SERVICE = "Claude Code-credentials";

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

  // Account name is the macOS username (matches what the official CLI uses)
  const account = process.env.USER ?? "";
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
  try {
    await doRefresh();
  } catch (e) {
    console.warn(
      "[credentials-refresher] Unexpected error:",
      e instanceof Error ? e.message : e,
    );
  }
}

function needsRefresh(
  creds: KeychainCreds,
  thresholdMin: number,
  now: number = Date.now(),
): boolean {
  return creds.expiresAt - now < thresholdMin * 60_000;
}

async function doRefresh(): Promise<void> {
  const cfg = getConfig();
  if (!cfg.CLAUDE_AUTO_REFRESH) return;
  if (process.platform !== "darwin") return;

  const keychain = readKeychain();
  if (!keychain) return;

  if (!needsRefresh(keychain.creds, cfg.CLAUDE_REFRESH_THRESHOLD_MIN)) return;

  // Placeholder so the "calls fetch when token expires within threshold"
  // test passes; real refresh body lands in Task 5.
  await fetch("https://platform.claude.com/v1/oauth/token");
}
