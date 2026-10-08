import {
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import { getProject, setChannelOverride } from "../../db/database.js";
import { getConfig } from "../../utils/config.js";
import { L } from "../../utils/i18n.js";

// Aliases resolve to the newest model of each family inside the SDK, so
// they stay current across SDK updates. Any full model id can be typed too.
const SUGGESTIONS = ["default", "opus", "sonnet", "haiku"];

export const data = new SlashCommandBuilder()
  .setName("model")
  .setDescription("Show or set the Claude model for this channel")
  .addStringOption((opt) =>
    opt
      .setName("name")
      .setDescription("opus / sonnet / haiku, a full model id, or 'default' to reset")
      .setAutocomplete(true)
      .setMaxLength(100),
  );

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const typed = interaction.options.getFocused().toLowerCase();
  const last = getProject(interaction.channelId)?.last_model;
  const options = [...new Set([...SUGGESTIONS, ...(last ? [last] : [])])]
    .filter((v) => v.toLowerCase().includes(typed));
  await interaction.respond(options.slice(0, 25).map((v) => ({ name: v, value: v })));
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const project = getProject(interaction.channelId);
  if (!project) {
    await interaction.editReply({
      content: L("❌ Register a project first with /register", "❌ 먼저 /register로 프로젝트를 등록하세요"),
    });
    return;
  }

  const name = interaction.options.getString("name")?.trim();
  let override = project.model ?? null;
  if (name) {
    override = name.toLowerCase() === "default" ? null : name;
    setChannelOverride(interaction.channelId, "model", override);
  }

  const effective = override ?? getConfig().CLAUDE_MODEL ?? "default";
  const lines = [
    `${L("Model", "모델")}: \`${effective}\``,
    project.last_model ? `${L("Last used", "마지막 사용")}: \`${project.last_model}\`` : "",
    name ? L("Applies from your next message.", "다음 메시지부터 적용됩니다.") : "",
    project.backend === "codex" ? L("⚠️ This channel uses Codex — ignored until you /claude.", "⚠️ 이 채널은 Codex 사용 중 — /claude 전환 전까지 무시됩니다.") : "",
  ].filter(Boolean);

  await interaction.editReply({
    embeds: [{ title: L("🧠 Claude Model", "🧠 Claude 모델"), description: lines.join("\n"), color: 0x7c3aed }],
  });
}
