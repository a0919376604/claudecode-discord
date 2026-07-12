import type { Client } from "discord.js";
import { runTick } from "./tick.js";
import { resolveWakeupDir } from "../wakeup/paths.js";

const TICK_INTERVAL_MS = 30_000;

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly discordClient: Client) {}

  async start(): Promise<void> {
    if (this.timer !== null) return;  // idempotent
    await this.tickOnce();  // catch-up
    this.timer = setInterval(() => {
      this.tickOnce().catch((e) => {
        console.error("[scheduler] unhandled tick error:", e);
      });
    }, TICK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tickOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await runTick({
        now: Date.now(),
        wakeupDir: resolveWakeupDir(),
        discordClient: this.discordClient,
        log: (msg, err) => console.warn(msg, err ?? ""),
      });
    } catch (e) {
      console.error("[scheduler] tick threw:", e);
    } finally {
      this.running = false;
    }
  }
}
