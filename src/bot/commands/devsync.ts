import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
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
  )
  .addSubcommand((sub) =>
    sub
      .setName("status")
      .setDescription("Show detailed sync status for a repo")
      .addStringOption((opt) =>
        opt
          .setName("repo")
          .setDescription("Repo name (active session)")
          .setRequired(true)
          .setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("flush")
      .setDescription("Force an immediate sync cycle for a repo")
      .addStringOption((opt) =>
        opt
          .setName("repo")
          .setDescription("Repo name (active session)")
          .setRequired(true)
          .setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("stop")
      .setDescription("Terminate the sync session for a repo")
      .addStringOption((opt) =>
        opt
          .setName("repo")
          .setDescription("Repo name (active session)")
          .setRequired(true)
          .setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("stop_all")
      .setDescription("Terminate every devsync-managed sync session"),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (sub === "doctor") return handleDoctor(interaction);
  if (sub === "ls") return handleLs(interaction);
  if (sub === "status") return handleStatus(interaction);
  if (sub === "flush") return handleFlush(interaction);
  if (sub === "stop") return handleStop(interaction);
  if (sub === "stop_all") return handleStopAll(interaction);
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

async function handleStatus(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const repo = interaction.options.getString("repo", true);
  const r = await runDevsync(["status", repo]);
  await replyWithResult(interaction, "status", r);
}

async function handleFlush(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const repo = interaction.options.getString("repo", true);
  const r = await runDevsync(["flush", repo]);
  await replyWithResult(interaction, "flush", r);
}

async function handleStop(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const repo = interaction.options.getString("repo", true);
  const r = await runDevsync(["stop", repo]);
  await replyWithResult(interaction, "stop", r);
}

/**
 * Parse `devsync ls` stdout and return the number of active sessions.
 * The CLI emits a Rich table; we count data lines by detecting "--" in the
 * session-name column. Fallback: if output contains "No active sessions", return 0.
 */
export function countSessionsInLs(stdout: string): number {
  if (/no active sessions/i.test(stdout)) return 0;
  const lines = stdout.split("\n");
  let count = 0;
  for (const line of lines) {
    // Session names are <repo>--<server>; the table will contain that pattern
    // in the Name column. Skip header / separator lines.
    if (/^\s*\S+--\S+/.test(line)) count += 1;
  }
  return count;
}

async function handleStopAll(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const ls = await runDevsync(["ls"]);
  if (!ls.ok) {
    await replyWithResult(interaction, "stop_all", ls);
    return;
  }
  const n = countSessionsInLs(ls.stdout);
  if (n === 0) {
    await interaction.editReply({
      content: L("(no sessions to terminate)", "(중지할 세션이 없습니다)"),
    });
    return;
  }
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("devsync:stop_all:confirm")
      .setLabel(L(`Confirm — terminate ${n} session(s)`, `확인 — ${n}개 세션 종료`))
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("devsync:stop_all:cancel")
      .setLabel(L("Cancel", "취소"))
      .setStyle(ButtonStyle.Secondary),
  );
  await interaction.editReply({
    content: L(
      `⚠️ About to terminate ${n} active devsync session(s).`,
      `⚠️ ${n}개의 devsync 세션을 종료하려고 합니다.`,
    ),
    components: [row],
  });
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
