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
  if (family === "start") {
    await interaction.deferUpdate();

    if (action === "cancel") {
      await interaction.editReply({
        content: L("Cancelled.", "취소되었습니다."),
        components: [],
      });
      return;
    }

    const sessionName = payload; // <repo>--<server>
    const sepIdx = sessionName.indexOf("--");
    if (sepIdx < 0) {
      await interaction.editReply({
        content: L(
          `Malformed session name in button: ${sessionName}`,
          `버튼에 잘못된 세션 이름: ${sessionName}`,
        ),
        components: [],
      });
      return;
    }
    const repo = sessionName.slice(0, sepIdx);
    const server = sessionName.slice(sepIdx + 2);

    if (action === "reuse") {
      await interaction.editReply({
        content: L(`✓ Reusing session \`${sessionName}\`.`, `✓ \`${sessionName}\` 세션 재사용.`),
        components: [],
      });
      return;
    }

    if (action === "restart") {
      const stop = await runDevsync(["stop", repo]);
      if (!stop.ok) {
        await interaction.editReply({
          content: L(
            `✗ Could not stop existing session (exit ${stop.code}):\n\`\`\`\n${stop.stderr || stop.stdout}\n\`\`\``,
            `✗ 기존 세션 중지 실패 (exit ${stop.code}):\n\`\`\`\n${stop.stderr || stop.stdout}\n\`\`\``,
          ),
          components: [],
        });
        return;
      }
      const create = await runDevsync(["start", repo, server, "--no-ssh"]);
      await interaction.editReply({
        content: create.ok
          ? L(`✓ Restarted \`${sessionName}\`.\n\`\`\`\n${create.stdout.trim() || ""}\n\`\`\``,
              `✓ \`${sessionName}\` 재시작 완료.\n\`\`\`\n${create.stdout.trim() || ""}\n\`\`\``)
          : L(`✗ Restart failed (exit ${create.code}):\n\`\`\`\n${create.stderr || create.stdout}\n\`\`\``,
              `✗ 재시작 실패 (exit ${create.code}):\n\`\`\`\n${create.stderr || create.stdout}\n\`\`\``),
        components: [],
      });
      return;
    }

    // Unknown action under "start" — log and end.
    console.warn(`[devsync-buttons] unknown start action: ${action}`);
    return;
  }
  // Unknown — log and silently swallow (the dispatcher already filtered prefix).
  console.warn(`[devsync-buttons] unknown customId: ${interaction.customId}`);
  if (!interaction.replied && !interaction.deferred) {
    await interaction.deferUpdate();
  }
}
