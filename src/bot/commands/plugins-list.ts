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
  .setDescription("List registered slash commands (plugin / user / project scope)")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const registered = pluginRegistry.list();
  const skipped = pluginRegistry.skippedList();

  if (registered.length === 0 && skipped.length === 0) {
    await interaction.editReply({
      content: L(
        "No slash commands discovered. Run `/plugins-sync` to refresh, or check that ~/.claude/plugins/installed_plugins.json lists your plugins and ~/.claude/commands/ has your user-scope .md files.",
        "발견된 슬래시 명령이 없습니다. `/plugins-sync`로 새로 고치거나 ~/.claude/plugins/installed_plugins.json 및 ~/.claude/commands/ 를 확인하세요.",
      ),
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(L("Slash Commands", "슬래시 명령"))
    .setColor(0x7c3aed)
    .setTimestamp();

  // Group registered commands by scope so users can immediately see whether
  // their /obsidian-init is showing up under "User" or "Plugin" (or missing
  // entirely from "Skipped"). Source label varies per scope:
  //  - plugin  → full pluginName (e.g. "claude-obsidian@claude-obsidian-marketplace")
  //  - user    → "~/.claude/commands"
  //  - project → projectPath, so multi-project setups can distinguish them
  if (registered.length > 0) {
    const scopeOrder: Array<["plugin" | "user" | "project", string]> = [
      ["plugin", L("Plugin", "플러그인")],
      ["user", L("User", "사용자")],
      ["project", L("Project", "프로젝트")],
    ];
    for (const [scope, label] of scopeOrder) {
      const items = registered.filter((c) => c.scope === scope);
      if (items.length === 0) continue;
      const lines = items.map((c) => {
        const paramInfo = c.parsedParams.length === 0
          ? "(args)"
          : c.parsedParams
              .map((p) => (p.required ? `<${p.name}>` : `[${p.name}]`))
              .join(" ");
        const source =
          scope === "plugin"
            ? c.pluginName
            : scope === "user"
              ? "~/.claude/commands"
              : c.projectPath ?? "<project>";
        return `\`/${c.commandName} ${paramInfo}\` — ${source}`;
      });
      embed.addFields({
        name: `${label} (${items.length})`,
        value: lines.join("\n").slice(0, 1024),
      });
    }
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
