import { SlashCommandBuilder, type ChatInputCommandInteraction, type CacheType } from "discord.js";
import { listSchedulesByChannel, deleteScheduleById } from "../../db/schedules.js";
import { listCronsByChannel, deleteCronById } from "../../db/crons.js";
import { L } from "../../utils/i18n.js";

export const data = new SlashCommandBuilder()
  .setName("schedules")
  .setDescription("Manage Claude's harness-scheduled tasks in this channel")
  .addSubcommand((sub) =>
    sub.setName("list").setDescription("List active schedules in this channel"))
  .addSubcommand((sub) =>
    sub.setName("cancel").setDescription("Cancel a schedule or cron by id")
      .addStringOption((o) => o.setName("id").setDescription("Schedule or cron id").setRequired(true)))
  .addSubcommand((sub) =>
    sub.setName("info").setDescription("Show details of a specific schedule/cron")
      .addStringOption((o) => o.setName("id").setDescription("Schedule or cron id").setRequired(true)));

export async function execute(interaction: ChatInputCommandInteraction<CacheType>): Promise<void> {
  const sub = interaction.options.getSubcommand();
  const channelId = interaction.channelId;

  if (sub === "list") {
    const content = formatScheduleList(channelId, Date.now());
    await interaction.editReply({ content });
    return;
  }

  if (sub === "cancel") {
    const id = interaction.options.getString("id", true);
    let ok = false;
    if (id.startsWith("sch_")) ok = deleteScheduleById(id);
    else if (id.startsWith("cron_")) ok = deleteCronById(id);
    await interaction.editReply({
      content: ok
        ? L(`✅ Cancelled ${id}`, `✅ ${id} 취소됨`)
        : L(`❌ Not found: ${id}`, `❌ 찾을 수 없음: ${id}`),
    });
    return;
  }

  if (sub === "info") {
    const id = interaction.options.getString("id", true);
    const content = formatScheduleInfo(channelId, id);
    await interaction.editReply({ content });
    return;
  }
}

export function formatScheduleList(channelId: string, now: number): string {
  const schedules = listSchedulesByChannel(channelId);
  const crons = listCronsByChannel(channelId);

  if (schedules.length === 0 && crons.length === 0) {
    return L("📅 No schedules in this channel.", "📅 이 채널에 예약이 없습니다.");
  }

  const lines: string[] = [L("📅 Current schedules", "📅 현재 예약")];
  if (schedules.length > 0) {
    lines.push(``, L(`⏱️ One-shot (${schedules.length})`, `⏱️ 일회성 (${schedules.length})`));
    for (const s of schedules) {
      const delta = humanize(s.fire_at - now);
      const preview = truncate(s.prompt, 60);
      lines.push(`  \`${s.id}\`  ${L(`in ${delta}`, `${delta} 후`)}  ${preview}`);
    }
  }
  if (crons.length > 0) {
    lines.push(``, L(`🔁 Cron (${crons.length})`, `🔁 Cron (${crons.length})`));
    for (const c of crons) {
      const delta = humanize(c.next_fire - now);
      const nameStr = c.name ? ` [${c.name}]` : "";
      const preview = truncate(c.prompt, 60);
      lines.push(`  \`${c.id}\`  \`${c.cron_expr}\`${nameStr}  ${L(`next in ${delta}`, `다음 ${delta} 후`)}  ${preview}`);
    }
  }
  return lines.join("\n");
}

function formatScheduleInfo(channelId: string, id: string): string {
  if (id.startsWith("sch_")) {
    const row = listSchedulesByChannel(channelId).find((r) => r.id === id);
    if (!row) return L(`❌ Not found: ${id}`, `❌ 찾을 수 없음: ${id}`);
    return [
      `📄 **${row.id}**`,
      `Fires at: ${new Date(row.fire_at).toISOString()}`,
      `TTL: ${row.ttl_seconds}s`,
      `Reason: ${row.reason ?? "(none)"}`,
      ``,
      `Prompt:`,
      `\`\`\``,
      row.prompt,
      `\`\`\``,
    ].join("\n");
  }
  if (id.startsWith("cron_")) {
    const row = listCronsByChannel(channelId).find((r) => r.id === id);
    if (!row) return L(`❌ Not found: ${id}`, `❌ 찾을 수 없음: ${id}`);
    return [
      `📄 **${row.id}** ${row.name ? `[${row.name}]` : ""}`,
      `Expression: \`${row.cron_expr}\``,
      `Next fire: ${new Date(row.next_fire).toISOString()}`,
      `Last fire: ${row.last_fire ? new Date(row.last_fire).toISOString() : "(never)"}`,
      ``,
      `Prompt:`,
      `\`\`\``,
      row.prompt,
      `\`\`\``,
    ].join("\n");
  }
  return L(`❌ Invalid id format: ${id}. Expected sch_* or cron_*.`, `❌ 잘못된 id: ${id}`);
}

function humanize(ms: number): string {
  const past = ms < 0;
  const abs = Math.abs(ms);
  const s = Math.floor(abs / 1000);
  if (s < 60) return past ? `${s}s ago` : `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return past ? `${m}m ${s % 60}s ago` : `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return past ? `${h}h ${m % 60}m ago` : `${h}h ${m % 60}m`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}
