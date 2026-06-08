import type { Client } from "discord.js";
import { getConfig } from "../utils/config.js";
import { ensureFreshCredentials } from "./credentials-refresher.js";

let timer: NodeJS.Timeout | null = null;

// Suppresses repeat-DM spam when the refresh token has been revoked.
// Cleared back to false on the next successful refresh, so a future
// re-login → expire → revoke cycle gets a fresh notification.
// NOT cleared on transient_error — the underlying revoked state
// hasn't been resolved.
let notifiedRevoked = false;

/**
 * Start the periodic credentials refresh timer.
 *
 * No-op (does not even register a timer) when CLAUDE_AUTO_REFRESH
 * is false or process.platform is not "darwin".
 *
 * Safe to call multiple times — second call is a no-op if a timer
 * is already running.
 */
export function startCredentialsHeartbeat(client: Client): void {
  if (timer) return; // already running
  const cfg = getConfig();
  if (!cfg.CLAUDE_AUTO_REFRESH) return;
  if (process.platform !== "darwin") return;

  const intervalMs = cfg.CLAUDE_REFRESH_INTERVAL_MIN * 60_000;
  timer = setInterval(() => void tick(client), intervalMs);
}

/**
 * Stop the periodic timer. Safe to call when no timer is running.
 */
export function stopCredentialsHeartbeat(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  notifiedRevoked = false;
}

async function tick(client: Client): Promise<void> {
  let outcome: import("./credentials-refresher.js").RefreshOutcome;
  try {
    outcome = await ensureFreshCredentials();
  } catch (e) {
    // Defense in depth — refresher contract says it never throws,
    // but if it ever does we don't want the timer to die.
    console.warn(
      "[heartbeat] Refresher threw (should not happen):",
      e instanceof Error ? e.message : e,
    );
    return;
  }

  switch (outcome.status) {
    case "skipped":
      return;
    case "refreshed":
      notifiedRevoked = false; // reset DM suppression
      return;
    case "transient_error":
      // Refresher already logged. Heartbeat will retry next tick.
      // Do NOT touch notifiedRevoked — a transient error in between
      // two revocations should not unsuppress the DM.
      return;
    case "revoked":
      if (notifiedRevoked) return;
      // Claim-first: set flag BEFORE awaiting DM. This guarantees
      // we attempt the DM at most once per revocation cycle even
      // if anything inside the DM path throws unexpectedly.
      notifiedRevoked = true;
      await notifyRevoked(client);
      return;
  }
}

async function notifyRevoked(client: Client): Promise<void> {
  try {
    const cfg = getConfig();
    const firstUserId = cfg.ALLOWED_USER_IDS[0];
    if (!firstUserId) return;
    const user = await client.users.fetch(firstUserId);
    await user.send(
      "🔑 Claude Code OAuth refresh token has expired or been revoked.\n" +
      "Please open a terminal on the bot host machine and run `claude login` to re-authenticate.\n\n" +
      "🔑 Claude Code OAuth 토큰이 만료되었거나 취소되었습니다.\n" +
      "봇 호스트 머신에서 터미널을 열고 `claude login`을 실행하여 재인증해 주세요."
    );
    console.log("[heartbeat] Sent revoke notification DM to first allowed user.");
  } catch (e) {
    console.warn(
      "[heartbeat] Failed to DM revoke notice:",
      e instanceof Error ? e.message : e,
    );
  }
}
