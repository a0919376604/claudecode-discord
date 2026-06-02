import { ButtonInteraction } from "discord.js";
import { runDevsync } from "../../utils/devsync-cli.js";
import { L } from "../../utils/i18n.js";

/**
 * Handle Discord button interactions whose customId starts with "devsync:".
 *
 * customId schema:
 *   devsync:start:reuse:<sessionName>
 *   devsync:start:restart:<sessionName>
 *   devsync:start:cancel
 *   devsync:stop_all:confirm
 *   devsync:stop_all:cancel
 *
 * NOTE: client.ts pre-parses the FIRST colon and routes here when
 * action === "devsync"; the raw customId still contains the full string.
 */
export async function handleDevsyncButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const parts = interaction.customId.split(":");
  // parts[0] === "devsync"
  const family = parts[1]; // "start" | "stop_all"
  const action = parts[2]; // "reuse" | "restart" | "cancel" | "confirm"
  const payload = parts.slice(3).join(":"); // e.g., sessionName "alpha--dl02"

  if (family === "stop_all" && action === "confirm") {
    await interaction.deferUpdate();
    const r = await runDevsync(["stop", "--all"]);
    await interaction.editReply({
      content: r.ok
        ? L(`✓ ${r.stdout.trim() || "All sessions terminated."}`, `✓ 모든 세션이 종료되었습니다.`)
        : L(`✗ stop --all failed (exit ${r.code})\n\`\`\`\n${r.stderr || r.stdout}\n\`\`\``,
            `✗ stop --all 실패 (exit ${r.code})\n\`\`\`\n${r.stderr || r.stdout}\n\`\`\``),
      components: [],
    });
    return;
  }
  if (family === "stop_all" && action === "cancel") {
    await interaction.deferUpdate();
    await interaction.editReply({
      content: L("Cancelled.", "취소되었습니다."),
      components: [],
    });
    return;
  }
  // start:* buttons wired in Task 7.
  if (family === "start") {
    // Placeholder until Task 7
    await interaction.deferUpdate();
    await interaction.editReply({
      content: L("Start button handler not yet implemented.", "Start 버튼 핸들러 미구현."),
      components: [],
    });
    // Reference unused payload var so TS strict noUnusedLocals is happy
    void payload;
    return;
  }
  // Unknown — log and silently swallow (the dispatcher already filtered prefix).
  console.warn(`[devsync-buttons] unknown customId: ${interaction.customId}`);
  if (!interaction.replied && !interaction.deferred) {
    await interaction.deferUpdate();
  }
}
