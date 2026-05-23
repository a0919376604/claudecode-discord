import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  REST,
  Routes,
  PermissionFlagsBits,
} from "discord.js";
import { scanInstalledPlugins } from "../../plugins/discovery.js";
import {
  pluginRegistry,
  commandMap,
  botOwnedCommandNames,
} from "../client.js";
import { handlePluginCommand } from "../../plugins/bridge.js";
import { getConfig } from "../../utils/config.js";
import { L } from "../../utils/i18n.js";

export const data = new SlashCommandBuilder()
  .setName("plugins-sync")
  .setDescription("Re-scan installed Claude plugins and refresh Discord slash commands")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const config = getConfig();

  const discovery = await scanInstalledPlugins();
  pluginRegistry.clear();
  const result = pluginRegistry.register(discovery.commands);

  // Live-update the in-memory commandMap so newly-arriving slash interactions
  // dispatch to the refreshed plugin thunks. Remove stale plugin entries first
  // (anything not in botOwnedCommandNames), then re-add the current set.
  for (const name of [...commandMap.keys()]) {
    if (!botOwnedCommandNames.has(name)) commandMap.delete(name);
  }
  for (const reg of result.registered) {
    commandMap.set(reg.commandName, {
      execute: (i: ChatInputCommandInteraction) => handlePluginCommand(i, reg),
    });
  }

  // Push the new full set to Discord
  try {
    const rest = new REST({ version: "10" }).setToken(config.DISCORD_BOT_TOKEN);
    const botOwnedData = Array.from(commandMap.values())
      .filter((c) => "data" in c && c.data)
      .map((c) => (c.data as { toJSON: () => unknown }).toJSON());
    const pluginData = pluginRegistry.toDiscordCommands().map((b) => b.toJSON());
    const commandData = [...botOwnedData, ...pluginData];
    await rest.put(
      Routes.applicationGuildCommands(
        (await rest.get(Routes.currentApplication()) as { id: string }).id,
        config.DISCORD_GUILD_ID,
      ),
      { body: commandData },
    );
  } catch (e) {
    await interaction.editReply({
      content: L(
        `Discovery succeeded but Discord registration failed: ${(e as Error).message}`,
        `발견은 성공했지만 Discord 등록이 실패했습니다: ${(e as Error).message}`,
      ),
    });
    return;
  }

  const lines = [
    L(
      `Re-scanned plugins: ${result.registered.length} command(s) registered, ${result.skipped.length} skipped.`,
      `플러그인 재검색: ${result.registered.length}개 명령 등록, ${result.skipped.length}개 건너뜀.`,
    ),
  ];
  if (discovery.warnings.length > 0) {
    lines.push("");
    lines.push(L("Warnings:", "경고:"));
    for (const w of discovery.warnings) lines.push(`  • ${w}`);
  }
  lines.push("");
  lines.push(L(
    "Note: Discord client may take up to 1 minute to refresh the autocomplete menu.",
    "참고: Discord 클라이언트가 자동 완성 메뉴를 새로 고치는 데 최대 1분이 걸릴 수 있습니다.",
  ));

  await interaction.editReply({ content: lines.join("\n") });
}
