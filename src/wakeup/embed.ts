import { EmbedBuilder } from "discord.js";
import { L } from "../utils/i18n.js";
import type { WakeupPayload } from "./types.js";

interface EmbedOptions {
  activeSession: boolean;
}

export function buildPassiveEmbed(payload: WakeupPayload, opts: EmbedOptions): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(0x2ECC71); // green — completion

  if (payload.source === "run-plan") {
    const meta = payload.metadata ?? {};
    const slot = String(meta.slot ?? "?");
    const status = String(meta.status ?? "?");
    const commits = String(meta.commits ?? "?");
    embed.setTitle(L(
      `🎯 Background task done — run-plan / ${slot}`,
      `🎯 백그라운드 작업 완료 — run-plan / ${slot}`,
    ));
    embed.addFields(
      { name: L("Status", "상태"), value: status, inline: true },
      { name: L("New commits", "새 커밋"), value: commits, inline: true },
    );
  } else {
    embed.setTitle(L(
      `🎯 Background task done — ${payload.source}`,
      `🎯 백그라운드 작업 완료 — ${payload.source}`,
    ));
    const meta = payload.metadata ?? {};
    const entries = Object.entries(meta).slice(0, 6); // bound to 6 fields
    for (const [k, v] of entries) {
      embed.addFields({ name: k, value: String(v), inline: true });
    }
  }

  if (opts.activeSession) {
    embed.setFooter({ text: L(
      "Will auto-verify after the current conversation ends",
      "현재 대화가 끝난 후 자동으로 검증합니다",
    ) });
  }

  return embed;
}
