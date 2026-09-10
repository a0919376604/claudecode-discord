import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./utils/config.js";
import { unwrapErrorMessage } from "./utils/error-format.js";
import { initDatabase } from "./db/database.js";
import { startBot } from "./bot/client.js";
import { ensureFreshCredentials } from "./claude/credentials-refresher.js";
import {
  startCredentialsHeartbeat,
  stopCredentialsHeartbeat,
} from "./claude/credentials-heartbeat.js";
import { startVpnKeepalive, stopVpnKeepalive } from "./vpn/keepalive.js";
import { startWakeupWatcher, stopWakeupWatcher } from "./wakeup/bootstrap.js";
import { Scheduler } from "./scheduler/daemon.js";

const LOCK_FILE = path.join(process.cwd(), ".bot.lock");
let scheduler: Scheduler | null = null;

function acquireLock(): boolean {
  try {
    // Check if lock file exists and process is still running
    if (fs.existsSync(LOCK_FILE)) {
      const pid = parseInt(fs.readFileSync(LOCK_FILE, "utf-8").trim(), 10);
      try {
        // signal 0 checks if process exists without killing it
        process.kill(pid, 0);
        return false; // process still running
      } catch {
        // process not running, stale lock file
      }
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid));
    return true;
  } catch {
    return false;
  }
}

function releaseLock(): void {
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {
    // ignore
  }
}

async function main() {
  if (!acquireLock()) {
    console.error("Another bot instance is already running. Exiting.");
    process.exit(1);
  }

  // Clean up lock file on exit
  process.on("exit", releaseLock);
  process.on("SIGINT", () => {
    stopCredentialsHeartbeat();
    stopVpnKeepalive();
    scheduler?.stop();
    stopWakeupWatcher().catch(() => {});
    releaseLock();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    stopCredentialsHeartbeat();
    stopVpnKeepalive();
    scheduler?.stop();
    stopWakeupWatcher().catch(() => {});
    releaseLock();
    process.exit(0);
  });

  // Global error handlers — prevent silent hangs from unhandled errors.
  // unwrapErrorMessage exposes shapeshift CombinedError sub-errors instead
  // of the opaque "Received one or more errors" top-level message.
  process.on("unhandledRejection", (reason) => {
    const detail = unwrapErrorMessage(reason);
    const stack = reason instanceof Error && reason.stack ? `\n${reason.stack}` : "";
    console.error(`Unhandled promise rejection: ${detail}${stack}`);
  });
  process.on("uncaughtException", (error) => {
    const detail = unwrapErrorMessage(error);
    console.error(`Uncaught exception: ${detail}${error.stack ? `\n${error.stack}` : ""}`);
    // Don't exit — let the bot keep running for non-fatal errors
  });

  console.log("Starting Claude Code Discord Controller...");

  // Load and validate config
  loadConfig();
  console.log("Config loaded");

  // Kick off a background credential refresh so the first user
  // request after bot startup doesn't have to wait for a refresh
  // round trip. Fire-and-forget — failures log internally.
  void ensureFreshCredentials();

  // Initialize database
  initDatabase();
  console.log("Database initialized");

  // Start Discord bot
  const client = await startBot();
  startCredentialsHeartbeat(client);
  console.log("Credentials heartbeat started");
  startVpnKeepalive(client);
  console.log("VPN keep-alive started");
  await startWakeupWatcher();
  console.log("Wake-up watcher started");
  scheduler = new Scheduler(client);
  await scheduler.start();
  console.log("Scheduler started");
  console.log("Bot is running!");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  releaseLock();
  process.exit(1);
});
