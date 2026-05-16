import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  PermissionFlagsBits,
} from "discord.js";
import fs from "node:fs";
import { unregisterProject, getProject } from "../../db/database.js";
import { sessionManager } from "../../claude/session-manager.js";
import { removeWorktree } from "../../utils/git.js";
import { L } from "../../utils/i18n.js";

export const data = new SlashCommandBuilder()
  .setName("unregister")
  .setDescription("Unregister this channel from its project")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const channelId = interaction.channelId;
  const project = getProject(channelId);

  if (!project) {
    await interaction.editReply({
      content: L(
        "This channel is not registered to any project.",
        "이 채널은 어떤 프로젝트에도 등록되어 있지 않습니다.",
      ),
    });
    return;
  }

  // Stop active session first so the worktree files aren't held open.
  await sessionManager.stopSession(channelId);

  // Worktree cleanup: only for channels created by /worktree.
  let worktreeCleanupNote = "";
  if (project.source_path) {
    try {
      removeWorktree(project.source_path, project.project_path);
      worktreeCleanupNote = L(
        `\nWorktree folder removed: \`${project.project_path}\``,
        `\nWorktree 폴더 삭제됨: \`${project.project_path}\``,
      );
    } catch {
      // git worktree remove failed (source repo gone, metadata broken, etc.)
      // Fall back to deleting the folder directly so the channel is left clean.
      try {
        fs.rmSync(project.project_path, { recursive: true, force: true });
        worktreeCleanupNote = L(
          `\nWorktree folder removed (forced): \`${project.project_path}\``,
          `\nWorktree 폴더 강제 삭제됨: \`${project.project_path}\``,
        );
      } catch (rmErr) {
        worktreeCleanupNote = L(
          `\nWarning: could not remove worktree folder \`${project.project_path}\`: ${(rmErr as Error).message}`,
          `\n경고: worktree 폴더 \`${project.project_path}\`를 삭제하지 못했습니다: ${(rmErr as Error).message}`,
        );
      }
    }
  }

  unregisterProject(channelId);

  await interaction.editReply({
    embeds: [
      {
        title: L("Project Unregistered", "프로젝트 등록 해제됨"),
        description:
          L(
            `Removed link to \`${project.project_path}\``,
            `\`${project.project_path}\` 연결이 해제되었습니다`,
          ) + worktreeCleanupNote,
        color: 0xff0000,
      },
    ],
  });
}
