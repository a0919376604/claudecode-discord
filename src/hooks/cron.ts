import { randomUUID } from "node:crypto";
import {
  insertCron, listCronsByChannel, deleteCronById, countCronsByChannel,
} from "../db/crons.js";
import { countSchedulesByChannel } from "../db/schedules.js";
import { validateCronExpr, nextFireAfter } from "../cron/parser.js";
import type { HookDeps, HookResult } from "./schedule-wakeup.js";

const MAX_PER_CHANNEL = 50;

function deny(reason: string): HookResult {
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

function isCronCreateInput(x: unknown): x is { schedule: string; prompt: string; name?: string } {
  return typeof x === "object" && x !== null
    && typeof (x as { schedule?: unknown }).schedule === "string"
    && typeof (x as { prompt?: unknown }).prompt === "string";
}

export function handleCronCreate(input: unknown, deps: HookDeps): HookResult {
  if (!isCronCreateInput(input)) {
    return deny("Invalid CronCreate input — expected {schedule, prompt}");
  }

  const total = countSchedulesByChannel(deps.channelId) + countCronsByChannel(deps.channelId);
  if (total >= MAX_PER_CHANNEL) {
    return deny(`Rate limit: this channel already has ${total} pending schedules/crons (max ${MAX_PER_CHANNEL}).`);
  }

  const validation = validateCronExpr(input.schedule);
  if (!validation.valid) {
    return deny(`Invalid cron expression "${input.schedule}": ${validation.error}`);
  }

  const now = deps.now();
  const id = `cron_${randomUUID().slice(0, 8)}`;
  const nextFire = nextFireAfter(input.schedule, now);

  insertCron({
    id,
    channel_id: deps.channelId,
    cron_expr: input.schedule,
    prompt: input.prompt,
    name: input.name ?? null,
    next_fire: nextFire,
    last_fire: null,
    created_at: now,
  });

  return deny(`Cron created (id: ${id}). Next fire: ${new Date(nextFire).toISOString()}`);
}

export function handleCronList(_input: unknown, deps: HookDeps): HookResult {
  const rows = listCronsByChannel(deps.channelId);
  if (rows.length === 0) {
    return deny("No crons in this channel.");
  }
  const lines = rows.map((r) => {
    const nameStr = r.name ? ` [${r.name}]` : "";
    const nextIso = new Date(r.next_fire).toISOString();
    return `  ${r.id}  "${r.cron_expr}"${nameStr}  next: ${nextIso}`;
  });
  return deny(`Crons in this channel (${rows.length}):\n${lines.join("\n")}`);
}

function isCronDeleteInput(x: unknown): x is { id: string } {
  return typeof x === "object" && x !== null
    && typeof (x as { id?: unknown }).id === "string";
}

export function handleCronDelete(input: unknown, _deps: HookDeps): HookResult {
  if (!isCronDeleteInput(input)) {
    return deny("Invalid CronDelete input — expected {id}");
  }
  const ok = deleteCronById(input.id);
  return deny(ok
    ? `Deleted ${input.id}`
    : `Cron ${input.id} not found in this channel`);
}
