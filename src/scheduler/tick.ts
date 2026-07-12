import type { Client } from "discord.js";
import {
  findDueSchedules, findExpiredSchedules, deleteScheduleById,
  type ScheduleRow,
} from "../db/schedules.js";
import {
  findDueCrons, updateCronFire, type CronRow,
} from "../db/crons.js";
import { nextFireAfter } from "../cron/parser.js";
import { writeWakeupFile } from "./wakeup-writer.js";
import { sendMissBundle } from "./miss-notifier.js";
import type { WakeupPayload } from "../wakeup/types.js";

const WAKEUP_FILE_TTL_SECONDS = 60;

export interface TickDeps {
  now: number;
  wakeupDir: string;
  discordClient: Client;
  log: (msg: string, err?: unknown) => void;
}

export async function runTick(deps: TickDeps): Promise<void> {
  const { now, wakeupDir, discordClient, log } = deps;

  // 1. Expired schedules → bundle & notify → delete
  const expired = findExpiredSchedules(now);
  if (expired.length > 0) {
    try {
      await sendMissBundle(discordClient, expired, log);
    } catch (e) {
      log("[tick] miss bundle send failed", e);
    }
    for (const row of expired) {
      try { deleteScheduleById(row.id); } catch (e) { log(`[tick] delete expired sch ${row.id} failed`, e); }
    }
  }

  // 2. Due schedules → write wakeup file → delete
  const dueSchedules = findDueSchedules(now);
  for (const row of dueSchedules) {
    try {
      await writeWakeupFile(wakeupDir, buildSchedulePayload(row, now));
      deleteScheduleById(row.id);
    } catch (e) {
      log(`[tick] due schedule ${row.id} failed`, e);
    }
  }

  // 3. Due crons → write wakeup file → update next_fire
  const dueCrons = findDueCrons(now);
  for (const row of dueCrons) {
    try {
      await writeWakeupFile(wakeupDir, buildCronPayload(row, now));
      const next = nextFireAfter(row.cron_expr, now);
      updateCronFire(row.id, now, next);
    } catch (e) {
      log(`[tick] due cron ${row.id} failed`, e);
    }
  }
}

function buildSchedulePayload(row: ScheduleRow, now: number): WakeupPayload {
  return {
    channel_id: row.channel_id,
    prompt: row.prompt,
    source: "schedule_wakeup",
    metadata: { schedule_id: row.id, ...(row.reason ? { reason: row.reason } : {}) },
    created_at: new Date(now).toISOString(),
    ttl_seconds: WAKEUP_FILE_TTL_SECONDS,
  };
}

function buildCronPayload(row: CronRow, now: number): WakeupPayload {
  return {
    channel_id: row.channel_id,
    prompt: row.prompt,
    source: "cron_fire",
    metadata: { cron_id: row.id, cron_expr: row.cron_expr, ...(row.name ? { name: row.name } : {}) },
    created_at: new Date(now).toISOString(),
    ttl_seconds: WAKEUP_FILE_TTL_SECONDS,
  };
}
