import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import type { Client } from "discord.js";
import { getConfig } from "../utils/config.js";
import { readServerNames } from "../utils/devsync-cli.js";

export type VpnStatus =
  | { connected: true; iface: string; ip: string }
  | { connected: false; reason: "down" | "script_missing" | "script_error" };

let timer: NodeJS.Timeout | null = null;

// Suppresses repeat DMs while VPN remains in a down state. Reset
// only on a true `connected: true` outcome (NOT on script_error
// or script_missing — those persist across ticks and re-DMing
// would be spam).
let notifiedDown = false;

// Ensures the "VPN up but no servers configured" log fires at
// most once per process lifetime. Resets if the process restarts.
let loggedEmptyServers = false;

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
  timer = setInterval(() => tick(client), intervalMs);
}

/**
 * Stop the periodic timer. Safe to call when no timer is running.
 */
export function stopVpnKeepalive(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  notifiedDown = false;
  loggedEmptyServers = false;
}

async function tick(client: Client): Promise<void> {
  let status: VpnStatus;
  try {
    status = await checkVpnStatus();
  } catch (e) {
    // Defense in depth — checkVpnStatus contract says it never throws.
    console.warn(
      "[vpn-keepalive] checkVpnStatus threw (should not happen):",
      e instanceof Error ? e.message : e,
    );
    return;
  }

  if (!status.connected) {
    if (notifiedDown) {
      console.log(`[vpn-keepalive] VPN still ${status.reason}, no DM.`);
      return;
    }
    // Claim-first: set flag BEFORE awaiting DM. Guarantees at most
    // one DM per drop event even if the DM path throws unexpectedly.
    notifiedDown = true;
    await notifyVpnDown(client, status.reason);
    return;
  }

  // VPN is up.
  if (notifiedDown) {
    notifiedDown = false;
    console.log("[vpn-keepalive] VPN recovered.");
  }

  const servers = readServerNames();
  if (servers.length === 0) {
    if (!loggedEmptyServers) {
      loggedEmptyServers = true;
      console.log(
        "[vpn-keepalive] VPN up but no servers configured — nothing to ping.",
      );
    }
    return;
  }
  // Fire-and-forget parallel pings. Each ping's outcome does NOT
  // affect the DM path — the keep-alive's job is to generate
  // traffic, not to verify connectivity.
  await Promise.all(servers.map((host) => pingHost(host)));
}

function pingHost(host: string): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn("ping", ["-c", "1", "-W", "1000", host], {
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {
      done();
      return;
    }
    proc.on("error", () => done());
    proc.on("close", () => done());
  });
}

async function notifyVpnDown(
  client: Client,
  reason: "down" | "script_missing" | "script_error",
): Promise<void> {
  try {
    const cfg = getConfig();
    const firstUserId = cfg.ALLOWED_USER_IDS[0];
    if (!firstUserId) return;
    const user = await client.users.fetch(firstUserId);
    await user.send(messageFor(reason));
    console.log(`[vpn-keepalive] Sent VPN-${reason} DM to first allowed user.`);
  } catch (e) {
    console.warn(
      "[vpn-keepalive] Failed to DM VPN-down notice:",
      e instanceof Error ? e.message : e,
    );
  }
}

function messageFor(reason: "down" | "script_missing" | "script_error"): string {
  if (reason === "down") {
    return (
      "🔌 VPN appears to be disconnected.\n" +
      "Run `/vpn connect` on the bot host, or open FortiClient and click Connect.\n" +
      "Active devsync sessions will resume sync once the tunnel is back.\n\n" +
      "🔌 VPN 연결이 끊어진 것 같습니다.\n" +
      "봇 호스트에서 `/vpn connect`를 실행하거나 FortiClient에서 Connect를 클릭하세요.\n" +
      "활성 devsync 세션은 터널 복구 후 자동으로 동기화를 재개합니다.\n\n" +
      "🔌 VPN 似乎已斷線。\n" +
      "請在 bot 主機上執行 `/vpn connect`,或開啟 FortiClient 點擊 Connect。\n" +
      "活躍的 devsync session 會在 tunnel 恢復後自動繼續同步。"
    );
  }
  if (reason === "script_missing") {
    return (
      "🔌 VPN keep-alive cannot run: `~/bin/vpn-status.sh` not found.\n" +
      "Either disable the feature (`VPN_KEEPALIVE_ENABLED=false`) or install the script.\n\n" +
      "🔌 VPN keep-alive을 실행할 수 없습니다: `~/bin/vpn-status.sh`을 찾을 수 없습니다.\n" +
      "기능을 비활성화(`VPN_KEEPALIVE_ENABLED=false`)하거나 스크립트를 설치하세요.\n\n" +
      "🔌 VPN keep-alive 無法執行:找不到 `~/bin/vpn-status.sh`。\n" +
      "請停用此功能(`VPN_KEEPALIVE_ENABLED=false`)或安裝該腳本。"
    );
  }
  // reason === "script_error"
  return (
    "🔌 VPN keep-alive cannot determine status: `~/bin/vpn-status.sh` failed unexpectedly.\n" +
    "Check the bot log for details.\n\n" +
    "🔌 VPN keep-alive이 상태를 확인할 수 없습니다: `~/bin/vpn-status.sh`이 예상치 못한 오류를 발생시켰습니다.\n" +
    "자세한 내용은 봇 로그를 확인하세요.\n\n" +
    "🔌 VPN keep-alive 無法判斷狀態:`~/bin/vpn-status.sh` 發生未預期的錯誤。\n" +
    "請查看 bot log 取得詳情。"
  );
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
