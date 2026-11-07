import { randomUUID } from "node:crypto";
import { EmbedBuilder, SlashCommandBuilder, type ChatInputCommandInteraction, type TextChannel } from "discord.js";
import { clearSessionId, getProject, setBackend } from "../../db/database.js";
import { getTutor, setTutorSession, upsertTutor } from "../../db/tutors.js";
import { countCronsByChannel, deleteCronById, insertCron, listCronsByChannel, type CronRow } from "../../db/crons.js";
import type { Tutor } from "../../db/types.js";
import { nextFireAfter } from "../../cron/parser.js";
import { localTimeToUtcCron } from "../../tutor/schedule.js";
import { buildDailyPrompt, buildIntakePrompt, buildWeeklyPrompt } from "../../tutor/prompts.js";
import { sessionManager } from "../../claude/session-manager.js";
import { L } from "../../utils/i18n.js";

export const data = new SlashCommandBuilder()
  .setName("tutor").setDescription(L("Configure your DeepTutor tutor", "DeepTutor 튜터 설정"))
  .addSubcommand(sub => sub.setName("setup").setDescription(L("Set up or update this channel's tutor", "이 채널의 튜터 설정 또는 수정"))
    .addStringOption(o => o.setName("subject").setDescription(L("Subject to study", "학습 과목")).setRequired(true).setMinLength(1).setMaxLength(200))
    .addStringOption(o => o.setName("goal").setDescription(L("Learning goal", "학습 목표")).setRequired(true).setMinLength(1).setMaxLength(1000))
    .addStringOption(o => o.setName("level").setDescription(L("Current level", "현재 수준")).setMaxLength(200))
    .addStringOption(o => o.setName("deadline").setDescription(L("Target deadline", "목표 기한")).setMaxLength(200))
    .addIntegerOption(o => o.setName("daily_minutes").setDescription(L("Daily study minutes (5–120)", "하루 학습 시간 (5–120분)")).setMinValue(5).setMaxValue(120))
    .addStringOption(o => o.setName("menu").setDescription(L("Lesson preferences", "수업 선호사항")).setMaxLength(1000))
    .addStringOption(o => o.setName("time").setDescription(L("Local push time, HH:MM (default 08:00)", "현지 알림 시간 HH:MM (기본 08:00)")))
    .addStringOption(o => o.setName("timezone").setDescription(L("Timezone (default Asia/Taipei)", "시간대 (기본 Asia/Taipei)")).setMaxLength(100))
    .addStringOption(o => o.setName("language").setDescription(L("DeepTutor language code (default zh)", "DeepTutor 언어 코드 (기본 zh)")).setMaxLength(100)))
  .addSubcommand(sub => sub.setName("show").setDescription(L("Show tutor settings and next pushes", "튜터 설정과 다음 알림 보기")))
  .addSubcommand(sub => sub.setName("pause").setDescription(L("Pause tutor pushes; setup resumes them", "튜터 알림 일시정지; setup으로 재개")))
  .addSubcommand(sub => sub.setName("reset").setDescription(L("Start a new learning path on the next message", "다음 메시지에서 새 학습 경로 시작")));

function isTutorCron(cron: CronRow): boolean {
  return cron.name === "tutor:daily" || cron.name === "tutor:weekly";
}

function tutorEmbed(tutor: Tutor, crons: CronRow[]): EmbedBuilder {
  const embed = new EmbedBuilder().setTitle(L("📚 DeepTutor tutor", "📚 DeepTutor 튜터")).setColor(0x5865f2)
    .addFields(
      { name: L("Subject", "과목"), value: tutor.subject },
      { name: L("Goal", "목표"), value: tutor.goal },
      { name: L("Push time", "알림 시간"), value: `${tutor.push_time} (${tutor.timezone})` },
      { name: L("Daily minutes", "하루 학습 시간"), value: String(tutor.daily_minutes ?? 15), inline: true },
      { name: L("Language", "언어"), value: tutor.language, inline: true },
    );
  if (tutor.level) embed.addFields({ name: L("Level", "수준"), value: tutor.level });
  if (tutor.deadline) embed.addFields({ name: L("Deadline", "기한"), value: tutor.deadline });
  if (tutor.menu) embed.addFields({ name: L("Preferences", "선호사항"), value: tutor.menu });
  for (const cron of crons) {
    embed.addFields({ name: cron.name!, value: `<t:${Math.floor(cron.next_fire / 1000)}:F>` });
  }
  if (!crons.length) embed.setFooter({ text: L("Pushes paused. Run /tutor setup to resume.", "알림이 일시정지되었습니다. /tutor setup으로 재개하세요.") });
  return embed;
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const channelId = interaction.channelId;
  const sub = interaction.options.getSubcommand();
  if (sub === "setup") {
    const project = getProject(channelId);
    if (!project) {
      await interaction.editReply({ content: L("❌ Register a project first with /register", "❌ 먼저 /register로 프로젝트를 등록하세요") });
      return;
    }
    if (sessionManager.isActive(channelId)) {
      await interaction.editReply({ content: L("❌ A session is running. Use /stop first.", "❌ 세션이 실행 중입니다. 먼저 /stop을 사용하세요.") });
      return;
    }
    const time = interaction.options.getString("time") ?? "08:00";
    const timezone = interaction.options.getString("timezone") ?? "Asia/Taipei";
    const now = Date.now();
    let daily: string;
    let weekly: string;
    try {
      daily = localTimeToUtcCron(time, timezone, undefined, new Date(now));
      weekly = localTimeToUtcCron(time, timezone, 0, new Date(now));
    } catch {
      await interaction.editReply({ content: L("❌ Invalid time or timezone. Use HH:MM and an IANA timezone such as Asia/Taipei.", "❌ 잘못된 시간 또는 시간대입니다. HH:MM 형식과 Asia/Taipei 같은 IANA 시간대를 사용하세요.") });
      return;
    }
    const oldCrons = listCronsByChannel(channelId).filter(isTutorCron);
    if (countCronsByChannel(channelId) - oldCrons.length + 2 > 50) {
      await interaction.editReply({ content: L("❌ Tutor setup needs two cron slots. Remove other schedules with /schedules first (limit 50).", "❌ 튜터 설정에 예약 2개가 필요합니다. /schedules로 다른 예약을 먼저 삭제하세요 (최대 50개).") });
      return;
    }
    upsertTutor({
      channel_id: channelId,
      subject: interaction.options.getString("subject", true), goal: interaction.options.getString("goal", true),
      level: interaction.options.getString("level"), deadline: interaction.options.getString("deadline"),
      daily_minutes: interaction.options.getInteger("daily_minutes"), menu: interaction.options.getString("menu"),
      push_time: time, timezone, language: interaction.options.getString("language") ?? "zh",
    });
    const tutor = getTutor(channelId)!;
    if (project.backend !== "deeptutor") {
      clearSessionId(channelId);
      setBackend(channelId, "deeptutor");
    }
    for (const cron of oldCrons) deleteCronById(cron.id);
    const crons: CronRow[] = [
      { id: randomUUID(), channel_id: channelId, name: "tutor:daily", cron_expr: daily, prompt: buildDailyPrompt(tutor), next_fire: nextFireAfter(daily, now), last_fire: null, created_at: now },
      { id: randomUUID(), channel_id: channelId, name: "tutor:weekly", cron_expr: weekly, prompt: buildWeeklyPrompt(tutor), next_fire: nextFireAfter(weekly, now), last_fire: null, created_at: now },
    ];
    for (const cron of crons) insertCron(cron);
    await interaction.editReply({ embeds: [tutorEmbed(tutor, crons)] });
    if (!tutor.deeptutor_session_id) {
      void sessionManager.sendMessage(interaction.channel as TextChannel, buildIntakePrompt(tutor))
        .catch(error => console.error("Tutor intake failed:", error));
    }
    return;
  }
  if (sub === "pause") {
    for (const cron of listCronsByChannel(channelId).filter(isTutorCron)) deleteCronById(cron.id);
    await interaction.editReply({ content: L("⏸️ Tutor pushes paused. Run /tutor setup to resume.", "⏸️ 튜터 알림이 일시정지되었습니다. /tutor setup으로 재개하세요.") });
    return;
  }
  const tutor = getTutor(channelId);
  if (!tutor) {
    await interaction.editReply({ content: L("No tutor configured. Run /tutor setup first.", "설정된 튜터가 없습니다. 먼저 /tutor setup을 실행하세요.") });
    return;
  }
  if (sub === "show") {
    await interaction.editReply({ embeds: [tutorEmbed(tutor, listCronsByChannel(channelId).filter(isTutorCron))] });
  } else if (sub === "reset") {
    if (sessionManager.isActive(channelId)) {
      await interaction.editReply({ content: L("❌ A session is running. Use /stop first.", "❌ 세션이 실행 중입니다. 먼저 /stop을 사용하세요.") });
      return;
    }
    setTutorSession(channelId, null);
    await interaction.editReply({ content: L("✅ Tutor reset. Your next message starts a new learning path.", "✅ 튜터가 초기화되었습니다. 다음 메시지에서 새 학습 경로를 시작합니다.") });
  }
}
