import { resolveWakeupDir } from "./paths.js";
import { WakeupWatcher } from "./watcher.js";
import { sessionManager } from "../claude/session-manager.js";
import { getProject } from "../db/database.js";
import { getDiscordClient } from "../bot/client.js";
import type { TextChannel, EmbedBuilder } from "discord.js";

let watcher: WakeupWatcher | null = null;

export async function startWakeupWatcher(): Promise<void> {
  if (watcher) return;
  const client = getDiscordClient();

  watcher = new WakeupWatcher({
    wakeupDir: resolveWakeupDir(),
    legacyDir: "/tmp",

    isChannelRegistered: (channelId) => Boolean(getProject(channelId)),
    hasActiveSession: (channelId) => sessionManager.isActive(channelId),

    wakeUp: async (channelId, prompt, source) => {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) {
        console.warn(`[wakeup] channel ${channelId} not fetchable`);
        return;
      }
      await sessionManager.wakeUp(channel as TextChannel, prompt, source);
    },

    sendPassiveEmbed: async (channelId, embed: EmbedBuilder) => {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) return;
      await (channel as TextChannel).send({ embeds: [embed] });
    },
  });

  await watcher.start();
}

export async function stopWakeupWatcher(): Promise<void> {
  if (watcher) {
    await watcher.stop();
    watcher = null;
  }
}
