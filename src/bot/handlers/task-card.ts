import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, StringSelectMenuBuilder, type ButtonInteraction, type StringSelectMenuInteraction, type TextChannel } from "discord.js";
import { sessionManager } from "../../claude/session-manager.js";
import { getProject, setChannelOverride } from "../../db/database.js";
import { isAllowedUser } from "../../security/guard.js";
import { CODEX_MODELS } from "../commands/model.js";
import { L } from "../../utils/i18n.js";

export async function handleTaskCardInteraction(interaction: ButtonInteraction | StringSelectMenuInteraction): Promise<void> {
  const ephemeral = { flags: MessageFlags.Ephemeral } as const;
  if (!isAllowedUser(interaction.user.id)) {
    await interaction.reply({ content: L("You are not authorized.", "권한이 없습니다."), ...ephemeral });
    return;
  }
  const [action, runId] = interaction.customId.split(":");
  const channelId = interaction.channelId;
  const card = channelId && sessionManager.getTaskCard(channelId, runId);
  const expired = L("This task control has expired. Use the latest task card or /status.", "이 작업 컨트롤은 만료되었습니다. 최신 작업 카드 또는 /status를 사용하세요.");
  if (!card || !channelId) {
    await interaction.reply({ content: expired, ...ephemeral });
    return;
  }
  if (action === "card-details") {
    await interaction.reply({ content: card.details(), allowedMentions: { parse: [] }, ...ephemeral });
    return;
  }
  if (action === "card-model" || action === "card-model-select") {
    const project = getProject(channelId);
    if (project?.backend !== "codex") {
      await interaction.reply({ content: expired, ...ephemeral });
      return;
    }
    const choices = [...new Set([...CODEX_MODELS, ...(project.codex_model ? [project.codex_model] : [])])];
    if (interaction.isStringSelectMenu()) {
      const value = interaction.values[0];
      if (!choices.includes(value)) {
        await interaction.reply({ content: expired, ...ephemeral });
        return;
      }
      setChannelOverride(channelId, "codex_model", value === "default" ? null : value);
      await interaction.update({ content: L(`Saved: ${value}. Applies from your next message in this channel.`, `저장됨: ${value}. 이 채널의 다음 메시지부터 적용됩니다.`), components: [], embeds: [] });
      return;
    }
    const select = new StringSelectMenuBuilder().setCustomId(`card-model-select:${runId}`)
      .setPlaceholder(L("Model for the next message", "다음 메시지 모델"))
      .addOptions(choices.map(value => ({ label: value === "default" ? L("Use Codex config", "Codex 설정 사용") : value, value, default: value === (project.codex_model ?? "default") })));
    await interaction.reply({
      content: L(
        `**Current task:** ${card.model ?? "Waiting for backend"}\n**Next message:** ${project.codex_model ?? "Codex config"}\nChanges apply from your next message in this channel. Use /model for another model ID. The global run-plan model is a separate setting.`,
        `**현재 작업:** ${card.model ?? "백엔드 응답 대기"}\n**다음 메시지:** ${project.codex_model ?? "Codex 설정"}\n변경 사항은 이 채널의 다음 메시지부터 적용됩니다. 다른 모델 ID는 /model을 사용하세요. 전역 run-plan 모델은 별도 설정입니다.`,
      ), components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)], ...ephemeral,
    });
    return;
  }
  if (!interaction.isButton()) return;
  if (action === "card-stop") {
    if (card.terminal || card.phase === "stopping") {
      await interaction.reply({ content: expired, ...ephemeral });
      return;
    }
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`card-stop-confirm:${runId}`).setLabel(L("Stop this task", "이 작업 중지")).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`card-cancel:${runId}`).setLabel(L("Keep running", "계속 실행")).setStyle(ButtonStyle.Secondary),
    );
    await interaction.reply({ content: L("Stop this task? Changes already made will be preserved.", "이 작업을 중지할까요? 이미 적용된 변경 사항은 보존됩니다."), components: [row], ...ephemeral });
  } else if (action === "card-stop-confirm") {
    await interaction.deferUpdate();
    const stopped = await sessionManager.stopTask(channelId, runId);
    await interaction.editReply({ content: stopped ? L("Stop request handled. See the task card for its status.", "중지 요청을 처리했습니다. 작업 카드에서 상태를 확인하세요.") : expired, components: [] });
  } else if (action === "card-cancel") {
    await interaction.update({ content: L("No stop request sent.", "중지 요청을 보내지 않았습니다."), components: [] });
  } else if (action === "card-recover") {
    await interaction.deferReply(ephemeral);
    await interaction.editReply({ content: L("Checking existing work before continuing…", "계속하기 전에 기존 작업을 확인합니다…") });
    const started = interaction.channel && await sessionManager.recoverTask(interaction.channel as TextChannel, runId, interaction.user.id);
    if (!started) await interaction.editReply({ content: expired });
  }
}
