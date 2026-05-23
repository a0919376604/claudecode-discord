import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
} from "discord.js";
import { pluginRegistry } from "../client.js";
import { L } from "../../utils/i18n.js";

export const data = new SlashCommandBuilder()
  .setName("plugins-list")
  .setDescription("List currently-registered plugin slash commands")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const registered = pluginRegistry.list();
  const skipped = pluginRegistry.skippedList();

  if (registered.length === 0 && skipped.length === 0) {
    await interaction.editReply({
      content: L(
        "No plugin commands discovered. Run `/plugins-sync` to refresh, or check that ~/.claude/plugins/installed_plugins.json lists your plugins.",
        "발견된 플러그인 명령이 없습니다. `/plugins-sync`로 새로 고치거나 ~/.claude/plugins/installed_plugins.json을 확인하세요.",
      ),
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(L("Plugin Commands", "플러그인 명령"))
    .setColor(0x7c3aed)
    .setTimestamp();

  if (registered.length > 0) {
    const lines = registered.map((c) => {
      const paramInfo = c.parsedParams.length === 0
        ? "(args)"
        : c.parsedParams
            .map((p) => (p.required ? `<${p.name}>` : `[${p.name}]`))
            .join(" ");
      return `\`/${c.commandName} ${paramInfo}\` — ${c.pluginName}`;
    });
    embed.addFields({
      name: L(`Registered (${registered.length})`, `등록됨 (${registered.length})`),
      value: lines.join("\n").slice(0, 1024),
    });
  }

  if (skipped.length > 0) {
    const lines = skipped.map(
      (s) => `\`/${s.commandName}\` (${s.pluginName}): ${s.reason}`,
    );
    embed.addFields({
      name: L(`Skipped (${skipped.length})`, `건너뜀 (${skipped.length})`),
      value: lines.join("\n").slice(0, 1024),
    });
  }

  await interaction.editReply({ embeds: [embed] });
}
