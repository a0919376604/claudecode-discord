import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import type { Client } from "discord.js";
import { getConfig } from "../utils/config.js";

export type VpnStatus =
  | { connected: true; iface: string; ip: string }
  | { connected: false; reason: "down" | "script_missing" | "script_error" };

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
  const status = await checkVpnStatus();
  // Task 5: act on `status`. For now, just log so cadence tests have
  // observable side-effects.
  if (!status.connected) {
    console.log(`[vpn-keepalive] VPN ${status.reason}.`);
  } else {
    console.log(`[vpn-keepalive] VPN up on ${status.iface} (${status.ip}).`);
  }
}

const VPN_STATUS_TIMEOUT_MS = 3000;

/**
 * Spawn ~/bin/vpn-status.sh and parse its stdout. Returns a
 * discriminated VpnStatus. Never throws — every failure path
 * is captured as `connected: false`.
 *
 * Exported for unit testing; not used by callers outside this module.
 */
export function checkVpnStatus(): Promise<VpnStatus> {
  const scriptPath = path.join(os.homedir(), "bin", "vpn-status.sh");
  return new Promise<VpnStatus>((resolve) => {
    let stdout = "";
    let settled = false;
    const settle = (s: VpnStatus) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(s);
    };

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(scriptPath, [], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      settle({ connected: false, reason: "script_missing" });
      return;
    }

    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* ignore */ }
      settle({ connected: false, reason: "script_error" });
    }, VPN_STATUS_TIMEOUT_MS);

    proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });

    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        settle({ connected: false, reason: "script_missing" });
      } else {
        settle({ connected: false, reason: "script_error" });
      }
    });

    proc.on("close", (code) => {
      if ((code ?? 0) !== 0) {
        settle({ connected: false, reason: "script_error" });
        return;
      }
      const trimmed = stdout.trimStart();
      if (trimmed.startsWith("✅")) {
        // Example: "✅ FortiClient VPN connected — utun4 (10.50.10.42)\n..."
        const m = trimmed.match(/^✅[^—]*—\s*(\S+)\s*\(([^)]+)\)/);
        if (m) {
          settle({ connected: true, iface: m[1], ip: m[2] });
          return;
        }
        // Connected per the icon but we couldn't parse iface/ip —
        // treat as script_error so the caller surfaces a problem.
        settle({ connected: false, reason: "script_error" });
        return;
      }
      if (trimmed.startsWith("❌")) {
        settle({ connected: false, reason: "down" });
        return;
      }
      settle({ connected: false, reason: "script_error" });
    });
  });
}
