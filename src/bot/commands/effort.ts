import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { EFFORT_LEVELS } from "../../agent/backend.js";
import { getProject, setChannelOverride } from "../../db/database.js";
import { L } from "../../utils/i18n.js";

export const data = new SlashCommandBuilder()
  .setName("effort")
  .setDescription("Show or set Claude's reasoning effort for this channel")
  .addStringOption((opt) =>
    opt
      .setName("level")
      .setDescription("Higher = more thinking, slower and more tokens")
      .addChoices(
        { name: "default", value: "default" },
        ...EFFORT_LEVELS.map((l) => ({ name: l, value: l })),
      ),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const project = getProject(interaction.channelId);
  if (!project) {
    await interaction.editReply({
      content: L("❌ Register a project first with /register", "❌ 먼저 /register로 프로젝트를 등록하세요"),
    });
    return;
  }

  const level = interaction.options.getString("level");
  let override = project.effort ?? null;
  if (level) {
    override = level === "default" ? null : level;
    setChannelOverride(interaction.channelId, "effort", override);
  }

  const lines = [
    `${L("Effort", "노력 수준")}: \`${override ?? L("default (model decides)", "기본값 (모델 결정)")}\``,
    level ? L("Applies from your next message. Levels the model doesn't support are lowered automatically.", "다음 메시지부터 적용됩니다. 모델이 지원하지 않는 수준은 자동으로 낮춰집니다.") : "",
    project.backend === "codex" ? L("⚠️ This channel uses Codex — ignored until you /claude.", "⚠️ 이 채널은 Codex 사용 중 — /claude 전환 전까지 무시됩니다.") : "",
  ].filter(Boolean);

  await interaction.editReply({
    embeds: [{ title: L("⚡ Reasoning Effort", "⚡ 추론 노력 수준"), description: lines.join("\n"), color: 0xf59e0b }],
  });
}
