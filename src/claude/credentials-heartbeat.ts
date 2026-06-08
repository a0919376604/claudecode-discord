import type { Client } from "discord.js";
import { getConfig } from "../utils/config.js";
import { ensureFreshCredentials } from "./credentials-refresher.js";

let timer: NodeJS.Timeout | null = null;

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
}

async function tick(_client: Client): Promise<void> {
  // Body filled out in Task 4. For now, just exercise the refresher
  // so the timer-cadence tests in Task 3 can observe the call count.
  await ensureFreshCredentials();
}
