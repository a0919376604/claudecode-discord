import type { ChatInputCommandInteraction, TextChannel } from "discord.js";
import { getProject } from "../db/database.js";
import { sessionManager } from "../claude/session-manager.js";
import { L } from "../utils/i18n.js";
import type { RegisteredPluginCommand } from "./types.js";

/**
 * Discord slash command handler for any plugin-derived command.
 *
 * client.ts has already called interaction.deferReply() before dispatch, so
 * any user-facing response from this function goes through editReply / followUp.
 *
 * On success, this function acknowledges the slash invocation via editReply
 * and hands the actual prompt off to sessionManager.sendMessage(), which
 * creates its own channel.send() messages for the streaming response —
 * identical to how freeform user messages are processed today.
 *
 * The prompt is built as `/<pluginShortName>:<commandName> <args>` because
 * the Claude Agent SDK exposes plugin commands under that namespaced form.
 * Bare names won't dispatch (Phase 0 finding).
 */
export async function handlePluginCommand(
  interaction: ChatInputCommandInteraction,
  registered: RegisteredPluginCommand,
): Promise<void> {
  const channelId = interaction.channelId;

  if (!getProject(channelId)) {
    await interaction.editReply({
      content: L(
        "This channel is not registered to a project. Run `/register` first.",
        "이 채널은 프로젝트에 등록되지 않았습니다. 먼저 `/register`를 사용하세요.",
      ),
    });
    return;
  }

  if (sessionManager.isActive(channelId)) {
    await interaction.editReply({
      content: L(
        "A task is already in progress in this channel. Wait for it to finish or use `/stop`.",
        "이 채널에서 이미 작업이 진행 중입니다. 완료될 때까지 기다리거나 `/stop`을 사용하세요.",
      ),
    });
    return;
  }

  const prompt = buildPrompt(interaction, registered);

  await interaction.editReply({
    content: L(`Running \`${prompt}\``, `실행 중: \`${prompt}\``),
  });

  const channel = interaction.channel as TextChannel;
  await sessionManager.sendMessage(channel, prompt);
}

function buildPrompt(
  interaction: ChatInputCommandInteraction,
  registered: RegisteredPluginCommand,
): string {
  const slashName = `${registered.pluginShortName}:${registered.commandName}`;

  if (registered.parsedParams.length === 0) {
    const args = (interaction.options.getString("args") ?? "").trim();
    return args ? `/${slashName} ${args}` : `/${slashName}`;
  }

  const sorted = [...registered.parsedParams].sort(
    (a, b) => a.originalIndex - b.originalIndex,
  );
  const values: string[] = [];
  for (const p of sorted) {
    const v = (interaction.options.getString(p.name) ?? "").trim();
    values.push(v);
  }
  while (values.length > 0 && values[values.length - 1] === "") {
    values.pop();
  }
  const joined = values.join(" ");
  return joined ? `/${slashName} ${joined}` : `/${slashName}`;
}
