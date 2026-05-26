import { getConfig } from "../utils/config.js";

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

async function doRefresh(): Promise<void> {
  if (!getConfig().CLAUDE_AUTO_REFRESH) return;
  if (process.platform !== "darwin") return;
  // Subsequent tasks fill in the rest.
}
