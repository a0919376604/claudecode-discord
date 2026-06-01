import { EmbedBuilder } from "discord.js";
import { WakeupPayloadSchema, isExpired, type WakeupPayload } from "./types.js";
import { enqueueWakeup } from "./queue.js";
import { buildPassiveEmbed } from "./embed.js";

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

  // start() / stop() / file parsing arrive in Task 6.
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  async start(): Promise<void> {}
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  async stop(): Promise<void> {}

  /** Exposed only so the schema can be re-parsed by callers without circular imports. */
  static schema = WakeupPayloadSchema;
}
