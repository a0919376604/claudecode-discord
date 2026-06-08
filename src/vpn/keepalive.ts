import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import type { Client } from "discord.js";
import { getConfig } from "../utils/config.js";

let timer: NodeJS.Timeout | null = null;

/**
 * Start the periodic VPN keep-alive timer.
 *
 * No-op (does not register a timer) when:
 *   - VPN_KEEPALIVE_ENABLED is false (the default)
 *   - process.platform !== "darwin"
 *
 * Safe to call multiple times — second call is a no-op if a timer
 * is already running.
 */
export function startVpnKeepalive(client: Client): void {
  if (timer) return;
  const cfg = getConfig();
  if (!cfg.VPN_KEEPALIVE_ENABLED) return;
  if (process.platform !== "darwin") return;

  const intervalMs = cfg.VPN_KEEPALIVE_INTERVAL_SEC * 1000;
  timer = setInterval(() => void tick(client), intervalMs);
}

/**
 * Stop the periodic timer. Safe to call when no timer is running.
 */
export function stopVpnKeepalive(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function tick(_client: Client): Promise<void> {
  // Body filled out in Tasks 4-5. For now, just spawn vpn-status.sh
  // so the lifecycle tests can observe the call (proves the timer
  // is wired correctly).
  await checkVpnStatusStub();
}

async function checkVpnStatusStub(): Promise<void> {
  const scriptPath = path.join(os.homedir(), "bin", "vpn-status.sh");
  return new Promise<void>((resolve) => {
    const proc = spawn(scriptPath, [], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.on("close", () => resolve());
    proc.on("error", () => resolve());
  });
}
