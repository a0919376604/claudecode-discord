import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { EmbedBuilder } from "discord.js";
import { WakeupPayloadSchema, isExpired, type WakeupPayload } from "./types.js";
import { enqueueWakeup } from "./queue.js";
import { buildPassiveEmbed } from "./embed.js";
import { synthesizePayloadFromDoneFile } from "./legacy-adapter.js";

export interface WakeupWatcherDeps {
  /** Absolute path to the generic wake-up JSON drop directory. */
  wakeupDir: string;
  /** Absolute path watched for legacy run-plan-done files (typically "/tmp"). */
  legacyDir: string;
  /** Returns true if `channelId` is a registered project. */
  isChannelRegistered: (channelId: string) => boolean;
  /** Returns true if a Claude session is currently running in `channelId`. */
  hasActiveSession: (channelId: string) => boolean;
  /** Spawn a new Claude session for `channelId` with `prompt`. */
  wakeUp: (channelId: string, prompt: string, source: string) => Promise<void>;
  /** Send the passive notification embed to `channelId`. */
  sendPassiveEmbed: (channelId: string, embed: EmbedBuilder) => Promise<void>;
}

export class WakeupWatcher {
  constructor(private readonly deps: WakeupWatcherDeps) {}

  private wakeupWatcher: fs.FSWatcher | null = null;
  private legacyWatcher: fs.FSWatcher | null = null;
  // Track in-flight processing to avoid double-handling when fs.watch fires
  // both rename + change for the same file on macOS/Windows.
  private inflight = new Set<string>();

  /**
   * Dispatch a validated payload. Pure with respect to the filesystem —
   * callers are responsible for parsing/validating the JSON and calling
   * this with a typed object.
   */
  async handleEvent(payload: WakeupPayload): Promise<void> {
    if (!this.deps.isChannelRegistered(payload.channel_id)) {
      console.warn(
        `[wakeup] dropping event for unregistered channel ${payload.channel_id} (source=${payload.source})`,
      );
      return;
    }

    if (isExpired(payload)) {
      console.warn(
        `[wakeup] dropping expired event for channel ${payload.channel_id} (created_at=${payload.created_at}, ttl=${payload.ttl_seconds}s)`,
      );
      return;
    }

    const active = this.deps.hasActiveSession(payload.channel_id);

    try {
      const embed = buildPassiveEmbed(payload, { activeSession: active });
      await this.deps.sendPassiveEmbed(payload.channel_id, embed);
    } catch (e) {
      // Embed failure shouldn't block the wakeup itself — log and continue.
      console.warn(
        `[wakeup] passive embed failed for ${payload.channel_id}:`,
        e instanceof Error ? e.message : e,
      );
    }

    if (active) {
      enqueueWakeup(payload);
      console.log(
        `[wakeup] queued for channel ${payload.channel_id} (source=${payload.source}) — session active`,
      );
    } else {
      try {
        await this.deps.wakeUp(payload.channel_id, payload.prompt, payload.source);
      } catch (e) {
        console.error(
          `[wakeup] wakeUp() failed for ${payload.channel_id}:`,
          e instanceof Error ? e.message : e,
        );
      }
    }
  }

  async start(): Promise<void> {
    await fsp.mkdir(this.deps.wakeupDir, { recursive: true });
    // Best-effort chmod 700 — fails silently on filesystems that don't support it (e.g., Windows FAT)
    try {
      await fsp.chmod(this.deps.wakeupDir, 0o700);
    } catch {
      // ignore
    }
    await fsp.mkdir(path.join(this.deps.wakeupDir, ".rejected"), { recursive: true });

    await this.scanWakeupDir();
    await this.scanLegacyDir();

    this.wakeupWatcher = fs.watch(this.deps.wakeupDir, (_event, filename) => {
      if (!filename) return;
      this.processWakeupFile(path.join(this.deps.wakeupDir, filename)).catch((e) => {
        console.warn(`[wakeup] processing ${filename} failed:`, e instanceof Error ? e.message : e);
      });
    });

    if (fs.existsSync(this.deps.legacyDir)) {
      this.legacyWatcher = fs.watch(this.deps.legacyDir, (_event, filename) => {
        if (!filename) return;
        const base = path.basename(filename);
        if (!base.startsWith("run-plan-done-") || !base.endsWith(".txt")) return;
        this.processLegacyFile(path.join(this.deps.legacyDir, base)).catch((e) => {
          console.warn(`[wakeup] legacy processing ${base} failed:`, e instanceof Error ? e.message : e);
        });
      });
    }
  }

  async stop(): Promise<void> {
    this.wakeupWatcher?.close();
    this.legacyWatcher?.close();
    this.wakeupWatcher = null;
    this.legacyWatcher = null;
  }

  private async scanWakeupDir(): Promise<void> {
    if (!fs.existsSync(this.deps.wakeupDir)) return;
    const entries = await fsp.readdir(this.deps.wakeupDir);
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      await this.processWakeupFile(path.join(this.deps.wakeupDir, name));
    }
  }

  private async scanLegacyDir(): Promise<void> {
    if (!fs.existsSync(this.deps.legacyDir)) return;
    const entries = await fsp.readdir(this.deps.legacyDir);
    for (const name of entries) {
      if (!name.startsWith("run-plan-done-") || !name.endsWith(".txt")) continue;
      await this.processLegacyFile(path.join(this.deps.legacyDir, name));
    }
  }

  private async processWakeupFile(filePath: string): Promise<void> {
    if (!filePath.endsWith(".json")) return;
    if (this.inflight.has(filePath)) return;
    this.inflight.add(filePath);
    try {
      if (!fs.existsSync(filePath)) return;
      const raw = await fsp.readFile(filePath, "utf-8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        await this.rejectFile(filePath, "invalid JSON");
        return;
      }
      const result = WakeupPayloadSchema.safeParse(parsed);
      if (!result.success) {
        await this.rejectFile(filePath, `schema violation: ${result.error.issues.map((i) => i.message).join("; ")}`);
        return;
      }
      await this.handleEvent(result.data);
      // Success → delete the trigger file
      await fsp.unlink(filePath).catch(() => {});
    } finally {
      this.inflight.delete(filePath);
    }
  }

  private async processLegacyFile(filePath: string): Promise<void> {
    if (this.inflight.has(filePath)) return;
    this.inflight.add(filePath);
    try {
      if (!fs.existsSync(filePath)) return;
      const payload = synthesizePayloadFromDoneFile(filePath, { metaDir: this.deps.legacyDir });
      if (!payload) {
        console.warn(`[wakeup] legacy adapter could not synthesize payload from ${filePath}`);
        return;
      }
      await this.handleEvent(payload);
      // NOTE: do NOT delete the legacy done file — skill owns that state
    } finally {
      this.inflight.delete(filePath);
    }
  }

  private async rejectFile(filePath: string, reason: string): Promise<void> {
    const dest = path.join(this.deps.wakeupDir, ".rejected", path.basename(filePath));
    try {
      await fsp.rename(filePath, dest);
      console.warn(`[wakeup] rejected ${path.basename(filePath)}: ${reason}`);
    } catch (e) {
      console.warn(`[wakeup] failed to move rejected file:`, e instanceof Error ? e.message : e);
    }
  }
}
