import type { Client, TextChannel } from "discord.js";
import { EmbedBuilder } from "discord.js";
import type { ScheduleRow } from "../db/schedules.js";
import { L } from "../utils/i18n.js";

/**
 * Group expired schedules by channel_id and send one bundled embed per channel.
 * Silently swallows send failures per channel — a broken channel shouldn't
 * block miss notifications to other channels.
 */
export async function sendMissBundle(
  client: Client,
  rows: ScheduleRow[],
  log: (msg: string, err?: unknown) => void,
): Promise<void> {
  const byChannel = new Map<string, ScheduleRow[]>();
  for (const row of rows) {
    const list = byChannel.get(row.channel_id) ?? [];
    list.push(row);
    byChannel.set(row.channel_id, list);
  }

  for (const [channelId, list] of byChannel) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel) continue;
      if (
        "isTextBased" in channel &&
        typeof channel.isTextBased === "function" &&
        !channel.isTextBased()
      ) {
        continue;
      }

      const embed = new EmbedBuilder()
        .setColor(0xFFA500)
        .setTitle(L(
          `⏰ Schedule miss (${list.length})`,
          `⏰ 예약 miss (${list.length}개)`,
        ))
        .setDescription(
          list.slice(0, 10).map((r) => {
            const ago = humanizeDelta(Date.now() - r.fire_at);
            const preview = r.prompt.length > 60 ? r.prompt.slice(0, 60) + "..." : r.prompt;
            return `• \`${r.id}\` (排定 ${ago} 前) — ${preview}`;
          }).join("\n") + (list.length > 10 ? `\n... 還有 ${list.length - 10} 條` : ""),
        );

      await (channel as TextChannel).send({ embeds: [embed] });
    } catch (e) {
      log(`[miss-notifier] failed to notify channel ${channelId}`, e);
    }
  }
}

function humanizeDelta(ms: number): string {
  const abs = Math.abs(ms);
  const min = Math.floor(abs / 60_000);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m`;
  return `${Math.floor(hr / 24)}d ${hr % 24}h`;
}
