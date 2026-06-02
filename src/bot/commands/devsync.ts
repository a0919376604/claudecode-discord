import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from "discord.js";
import { runDevsync, type DevsyncResult } from "../../utils/devsync-cli.js";
import { L } from "../../utils/i18n.js";

const MAX_DISCORD_BODY = 1900; // leave room for code-fence overhead

export const data = new SlashCommandBuilder()
  .setName("devsync")
  .setDescription("Control the local devsync CLI (mutagen wrapper)")
  .addSubcommand((sub) =>
    sub.setName("doctor").setDescription("Health-check daemon + servers"),
  )
  .addSubcommand((sub) =>
    sub.setName("ls").setDescription("List active devsync-managed sync sessions"),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (sub === "doctor") return handleDoctor(interaction);
  if (sub === "ls") return handleLs(interaction);
  // Future subcommands wired in later tasks.
  await interaction.editReply({
    content: L(`Unknown subcommand: ${sub}`, `알 수 없는 하위 명령: ${sub}`),
  });
}

// ─── Subcommand handlers ───

async function handleDoctor(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const r = await runDevsync(["doctor"]);
  await replyWithResult(interaction, "doctor", r);
}

async function handleLs(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const r = await runDevsync(["ls"]);
  await replyWithResult(interaction, "ls", r);
}

// ─── Helpers ───

function truncate(text: string): string {
  if (text.length <= MAX_DISCORD_BODY) return text;
  return text.slice(0, MAX_DISCORD_BODY) + "\n... (truncated)";
}

async function replyWithResult(
  interaction: ChatInputCommandInteraction,
  subcommand: string,
  r: DevsyncResult,
): Promise<void> {
  if (r.ok) {
    await interaction.editReply({
      content: `\`\`\`\n${truncate(r.stdout || "(no output)")}\n\`\`\``,
    });
    return;
  }
  const body = truncate(r.stderr || r.stdout || "(no output)");
  let content = `✗ devsync ${subcommand} failed (exit ${r.code})\n\`\`\`\n${body}\n\`\`\``;
  // Hint enrichment is added in Task 11.
  await interaction.editReply({ content });
}
