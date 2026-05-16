import {
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  SlashCommandBuilder,
  PermissionFlagsBits,
} from "discord.js";
import fs from "node:fs";
import path from "node:path";
import { registerWorktreeProject, getProject } from "../../db/database.js";
import { validateProjectPath } from "../../security/guard.js";
import { getConfig } from "../../utils/config.js";
import { L } from "../../utils/i18n.js";
import {
  isGitRepo,
  addWorktree,
  removeWorktree,
  pickNextWorktreeName,
} from "../../utils/git.js";

export const data = new SlashCommandBuilder()
  .setName("worktree")
  .setDescription("Create a git worktree of a project and register this channel to it")
  .addStringOption((opt) =>
    opt
      .setName("path")
      .setDescription(`Source repo folder name (${getConfig().BASE_PROJECT_DIR})`)
      .setRequired(true)
      .setAutocomplete(true),
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const input = interaction.options.getString("path", true);
  const config = getConfig();
  const sourcePath = path.isAbsolute(input)
    ? input
    : path.join(config.BASE_PROJECT_DIR, input);
  const channelId = interaction.channelId;
  const guildId = interaction.guildId!;

  // Reject if channel already registered (mirrors /register).
  const existing = getProject(channelId);
  if (existing) {
    await interaction.editReply({
      content: L(
        `This channel is already registered to \`${existing.project_path}\`. Use \`/unregister\` first.`,
        `이 채널은 이미 \`${existing.project_path}\`에 등록되어 있습니다. 먼저 \`/unregister\`를 사용하세요.`,
      ),
    });
    return;
  }

  // Source must exist and be a git repo.
  if (!fs.existsSync(sourcePath)) {
    await interaction.editReply({
      content: L(
        `Source path does not exist: \`${sourcePath}\``,
        `소스 경로가 존재하지 않습니다: \`${sourcePath}\``,
      ),
    });
    return;
  }
  if (!isGitRepo(sourcePath)) {
    await interaction.editReply({
      content: L(
        `Source path is not a git repository: \`${sourcePath}\``,
        `소스 경로는 git 저장소가 아닙니다: \`${sourcePath}\``,
      ),
    });
    return;
  }

  // Pick the next available worktree name + path.
  const { branchName, worktreePath } = pickNextWorktreeName(sourcePath);

  // Create the worktree.
  try {
    addWorktree(sourcePath, branchName, worktreePath);
  } catch (err) {
    await interaction.editReply({
      content: L(
        `git worktree add failed: ${(err as Error).message}`,
        `git worktree add 실패: ${(err as Error).message}`,
      ),
    });
    return;
  }

  // Now that the worktree folder exists, run the standard project-path validation.
  const validationError = validateProjectPath(worktreePath);
  if (validationError) {
    // The worktree was created but is outside the allowed area — roll it back
    // so we don't leave orphan state.
    try {
      removeWorktree(sourcePath, worktreePath);
    } catch {
      // Best-effort cleanup; original validation error is the real failure.
    }
    await interaction.editReply({
      content: L(
        `Invalid worktree path: ${validationError}`,
        `잘못된 worktree 경로: ${validationError}`,
      ),
    });
    return;
  }

  registerWorktreeProject(channelId, worktreePath, guildId, sourcePath);

  await interaction.editReply({
    embeds: [
      {
        title: L("Worktree Created", "Worktree 생성됨"),
        description: L(
          `This channel is now linked to:\n\`${worktreePath}\``,
          `이 채널이 연결되었습니다:\n\`${worktreePath}\``,
        ),
        color: 0x00ff00,
        fields: [
          {
            name: L("Worktree of", "원본 프로젝트"),
            value: `\`${sourcePath}\``,
            inline: false,
          },
          {
            name: L("Branch", "브랜치"),
            value: `\`${branchName}\``,
            inline: true,
          },
          {
            name: L("Status", "상태"),
            value: L("🔴 Offline", "🔴 오프라인"),
            inline: true,
          },
          {
            name: L("Auto-approve", "자동 승인"),
            value: L("Off", "꺼짐"),
            inline: true,
          },
        ],
      },
    ],
  });
}

export async function autocomplete(
  interaction: AutocompleteInteraction,
): Promise<void> {
  const focused = interaction.options.getFocused();
  const config = getConfig();
  const baseDir = config.BASE_PROJECT_DIR;

  try {
    const lastSlash = focused.lastIndexOf("/");
    const parentPart = lastSlash >= 0 ? focused.slice(0, lastSlash) : "";
    const currentPrefix = lastSlash >= 0 ? focused.slice(lastSlash + 1) : focused;

    const listDir = parentPart ? path.join(baseDir, parentPart) : baseDir;

    const resolvedList = path.resolve(listDir);
    const resolvedBase = path.resolve(baseDir);
    if (!resolvedList.startsWith(resolvedBase)) {
      await interaction.respond([]);
      return;
    }

    const entries = fs.readdirSync(listDir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .filter((name) => name.toLowerCase().includes(currentPrefix.toLowerCase()))
      .slice(0, 25);

    const choices = dirs.map((name) => {
      const value = parentPart ? `${parentPart}/${name}` : name;
      return { name: value, value };
    });

    await interaction.respond(choices.slice(0, 25));
  } catch {
    await interaction.respond([]);
  }
}
