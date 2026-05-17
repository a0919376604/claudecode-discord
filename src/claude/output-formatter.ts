import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} from "discord.js";
import { L } from "../utils/i18n.js";

const MAX_DISCORD_LENGTH = 1900; // leave room for formatting

export function formatStreamChunk(text: string): string {
  if (text.length <= MAX_DISCORD_LENGTH) return text;
  return text.slice(0, MAX_DISCORD_LENGTH) + "\n" + L("... (truncated)", "... (잘림)");
}

export function splitMessage(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_DISCORD_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline
    let splitAt = remaining.lastIndexOf("\n", MAX_DISCORD_LENGTH);
    if (splitAt === -1 || splitAt < MAX_DISCORD_LENGTH / 2) {
      splitAt = MAX_DISCORD_LENGTH;
    }

    let chunk = remaining.slice(0, splitAt);
    remaining = remaining.slice(splitAt);

    // Check if we're splitting inside an unclosed code block
    const fenceRegex = /^```/gm;
    let insideBlock = false;
    let blockLang = "";
    let match;
    while ((match = fenceRegex.exec(chunk)) !== null) {
      if (insideBlock) {
        insideBlock = false;
        blockLang = "";
      } else {
        insideBlock = true;
        const lineEnd = chunk.indexOf("\n", match.index);
        blockLang = chunk.slice(match.index + 3, lineEnd === -1 ? undefined : lineEnd).trim();
      }
    }

    if (insideBlock) {
      // Close the code block in this chunk, reopen in the next
      chunk += "\n```";
      remaining = "```" + blockLang + "\n" + remaining;
    }

    chunks.push(chunk);
  }

  return chunks;
}

export function createStopButton(
  channelId: string,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`stop:${channelId}`)
      .setLabel(L("Stop", "중지"))
      .setStyle(ButtonStyle.Danger)
      .setEmoji("⏹️"),
  );
}

export function createCompletedButton(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("completed")
      .setLabel(L("Completed", "완료됨"))
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("✅")
      .setDisabled(true),
  );
}

export function createFinishFeatureButton(
  channelId: string,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`finish-feature:${channelId}`)
      .setLabel(L("Finish Feature", "기능 완료"))
      .setStyle(ButtonStyle.Success)
      .setEmoji("✅"),
  );
}

export function createToolApprovalEmbed(
  toolName: string,
  input: Record<string, unknown>,
  requestId: string,
): { embed: EmbedBuilder; row: ActionRowBuilder<ButtonBuilder> } {
  const embed = new EmbedBuilder()
    .setTitle(L(`🔧 Tool Use: ${toolName}`, `🔧 도구 사용: ${toolName}`))
    .setColor(0xffa500)
    .setTimestamp();

  // Add relevant fields based on tool type
  if (toolName === "Edit" || toolName === "Write") {
    const filePath = (input.file_path as string) ?? "unknown";
    embed.addFields({ name: L("File", "파일"), value: `\`${filePath}\``, inline: false });

    if (input.old_string && input.new_string) {
      const diff = `\`\`\`diff\n- ${String(input.old_string).slice(0, 500)}\n+ ${String(input.new_string).slice(0, 500)}\n\`\`\``;
      embed.addFields({ name: L("Changes", "변경 사항"), value: diff, inline: false });
    } else if (input.content) {
      const preview = String(input.content).slice(0, 500);
      embed.addFields({
        name: L("Content Preview", "내용 미리보기"),
        value: `\`\`\`\n${preview}\n\`\`\``,
        inline: false,
      });
    }
  } else if (toolName === "Bash") {
    const command = (input.command as string) ?? "unknown";
    const description = (input.description as string) ?? "";
    embed.addFields(
      { name: L("Command", "명령어"), value: `\`\`\`bash\n${command}\n\`\`\``, inline: false },
    );
    if (description) {
      embed.addFields({ name: L("Description", "설명"), value: description, inline: false });
    }
  } else {
    // Generic tool display - skip empty input
    const summary = JSON.stringify(input, null, 2);
    if (summary && summary !== "{}") {
      embed.addFields({
        name: L("Input", "입력"),
        value: `\`\`\`json\n${summary.slice(0, 800)}\n\`\`\``,
        inline: false,
      });
    }
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`approve:${requestId}`)
      .setLabel(L("Approve", "승인"))
      .setStyle(ButtonStyle.Success)
      .setEmoji("✅"),
    new ButtonBuilder()
      .setCustomId(`deny:${requestId}`)
      .setLabel(L("Deny", "거부"))
      .setStyle(ButtonStyle.Danger)
      .setEmoji("❌"),
    new ButtonBuilder()
      .setCustomId(`approve-all:${requestId}`)
      .setLabel(L("Auto-approve All", "모두 자동 승인"))
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("⚡"),
  );

  return { embed, row };
}

export interface AskQuestionData {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

export function createAskUserQuestionEmbed(
  questionData: AskQuestionData,
  requestId: string,
  questionIndex: number,
  totalQuestions: number,
): { embed: EmbedBuilder; components: ActionRowBuilder<any>[] } {
  const title =
    totalQuestions > 1
      ? `❓ ${questionData.header} (${questionIndex + 1}/${totalQuestions})`
      : `❓ ${questionData.header}`;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(questionData.question)
    .setColor(0x7c3aed)
    .setTimestamp();

  // Add option descriptions as embed fields
  for (const opt of questionData.options) {
    embed.addFields({
      name: opt.label,
      value: opt.description || "\u200b",
      inline: false,
    });
  }

  const components: ActionRowBuilder<any>[] = [];

  if (questionData.multiSelect) {
    // Use StringSelectMenu for multi-select
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`ask-select:${requestId}`)
      .setPlaceholder(L("Select options...", "옵션을 선택하세요..."))
      .setMinValues(1)
      .setMaxValues(questionData.options.length)
      .addOptions(
        questionData.options.map((opt, i) => ({
          label: opt.label.slice(0, 100),
          value: String(i),
          ...(opt.description
            ? { description: opt.description.slice(0, 100) }
            : {}),
        })),
      );

    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu),
    );

    // Custom input button in separate row
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`ask-other:${requestId}`)
          .setLabel(L("Custom input", "직접 입력"))
          .setStyle(ButtonStyle.Secondary)
          .setEmoji("✏️"),
      ),
    );
  } else {
    // Use buttons for single select
    const buttons: ButtonBuilder[] = questionData.options.map((opt, i) =>
      new ButtonBuilder()
        .setCustomId(`ask-opt:${requestId}:${i}`)
        .setLabel(opt.label.slice(0, 80))
        .setStyle(i === 0 ? ButtonStyle.Primary : ButtonStyle.Secondary),
    );

    // Custom input button
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`ask-other:${requestId}`)
        .setLabel(L("Custom input", "직접 입력"))
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("✏️"),
    );

    // Discord max 5 buttons per row
    for (let i = 0; i < buttons.length; i += 5) {
      components.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          ...buttons.slice(i, i + 5),
        ),
      );
    }
  }

  return { embed, components };
}

export function createResultEmbed(
  result: string,
  costUsd: number,
  durationMs: number,
  showCost: boolean = true,
  isError: boolean = false,
): EmbedBuilder {
  const duration = `${(durationMs / 1000).toFixed(1)}s`;
  const footer = showCost
    ? `${L("Cost (est.)", "비용 (추정)")} : $${costUsd.toFixed(4)}  |  ${L("Duration", "소요 시간")} : ${duration}`
    : `${L("Duration", "소요 시간")} : ${duration}`;

  // Error results (SDKResultError: error_during_execution / error_max_turns
  // / error_max_budget_usd / error_max_structured_output_retries) come
  // through here too. Surface them as a proper red embed with the joined
  // errors[] text so the user understands the session ended in failure —
  // previously these were silently dropped because the calling site only
  // matched on `"result" in message`, which is false for SDKResultError.
  const title = isError
    ? L("❌ Task Failed", "❌ 작업 실패")
    : L("✅ Task Complete", "✅ 작업 완료");
  const color = isError ? 0xff0000 : 0x00ff00;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(result.slice(0, 4000))
    .setColor(color)
    .setFooter({ text: footer })
    .setTimestamp();

  return embed;
}
