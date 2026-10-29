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
export const CODEX_MODELS = ["default", "gpt-6.1-sol", "gpt-6-astra"];

export const data = new SlashCommandBuilder()
  .setName("model")
  .setDescription("Show or set the active backend's model for this channel")
  .addStringOption((opt) =>
    opt
      .setName("name")
      .setDescription("A model id for Claude or Codex, or 'default' to reset")
      .setAutocomplete(true)
      .setMaxLength(100),
  );

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const typed = interaction.options.getFocused().toLowerCase();
  const project = getProject(interaction.channelId);
  const last = project?.last_model;
  const suggestions = project?.backend === "codex" ? CODEX_MODELS : SUGGESTIONS;
  const compatibleLast = last && (project?.backend === "codex" ? !last.startsWith("claude") : !last.startsWith("gpt-"));
  const options = [...new Set([...suggestions, ...(compatibleLast ? [last] : [])])]
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
  const isCodex = project.backend === "codex";
  let override = (isCodex ? project.codex_model : project.model) ?? null;
  if (name) {
    override = name.toLowerCase() === "default" ? null : name;
    setChannelOverride(interaction.channelId, isCodex ? "codex_model" : "model", override);
  }

  const effective = override ?? (isCodex ? "Codex config" : getConfig().CLAUDE_MODEL ?? "default");
  const lines = [
    `${L("Model", "모델")}: \`${effective}\``,
    project.last_model ? `${L("Last used", "마지막 사용")}: \`${project.last_model}\`` : "",
    name ? L("Applies from your next message.", "다음 메시지부터 적용됩니다.") : "",
    isCodex ? L("This channel only. The global run-plan model is a separate setting.", "이 채널에만 적용됩니다. 전역 run-plan 모델은 별도 설정입니다.") : "",
  ].filter(Boolean);

  await interaction.editReply({
    embeds: [{ title: `🧠 ${isCodex ? "Codex" : "Claude"} ${L("Model", "모델")}`, description: lines.join("\n"), color: 0x7c3aed }],
  });
}
