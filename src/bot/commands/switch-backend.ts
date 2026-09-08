import {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ChatInputCommandInteraction,
} from "discord.js";
import { getProject } from "../../db/database.js";
import { sessionManager } from "../../claude/session-manager.js";
import { L } from "../../utils/i18n.js";

export function createSwitchBackendCommand(target: "claude" | "codex", displayName: string) {
  return {
    data: new SlashCommandBuilder()
      .setName(target)
      .setDescription(L(`Switch this channel to use ${displayName}`, `이 채널을 ${displayName}로 전환`)),

    async execute(interaction: ChatInputCommandInteraction): Promise<void> {
      const project = getProject(interaction.channelId);
      if (!project) {
        await interaction.editReply({
          content: L("❌ Register a project first with /register", "❌ 먼저 /register로 프로젝트를 등록하세요"),
        });
        return;
      }

      if (project.backend === target) {
        await interaction.editReply({
          content: L(`✅ Already using ${displayName} on this channel.`, `✅ 이미 ${displayName}를 사용 중입니다.`),
        });
        return;
      }

      if (sessionManager.isActive(interaction.channelId)) {
        await interaction.editReply({
          content: L(
            `⚠️ A session is currently running. Use /stop first, then try /${target} again.`,
            `⚠️ 세션이 실행 중입니다. /stop 후 다시 /${target}를 시도하세요.`,
          ),
        });
        return;
      }

      const confirmBase = `switch-${target}-${interaction.channelId}`;
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`${confirmBase}-yes`)
          .setLabel(L("Yes, switch", "예, 전환"))
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`${confirmBase}-no`)
          .setLabel(L("Cancel", "취소"))
          .setStyle(ButtonStyle.Secondary),
      );
      const currentDisplay = project.backend === "claude" ? "Claude" : "Codex";
      await interaction.editReply({
        content: L(
          `⚠️ Switching from **${currentDisplay}** to **${displayName}** will clear the existing ${currentDisplay} session on this channel. The old session file still exists on disk but this channel will no longer resume it. Continue?`,
          `⚠️ **${currentDisplay}**에서 **${displayName}**로 전환하면 이 채널의 기존 ${currentDisplay} 세션이 초기화됩니다. 세션 파일은 디스크에 남지만 이 채널에서는 더 이상 이어갈 수 없습니다. 계속할까요?`,
        ),
        components: [row],
      });
    },
  };
}
