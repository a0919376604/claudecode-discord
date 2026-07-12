import { randomUUID } from "node:crypto";
import type { TextChannel } from "discord.js";
import { insertSchedule, countSchedulesByChannel } from "../db/schedules.js";
import { countCronsByChannel } from "../db/crons.js";

export interface HookDeps {
  channelId: string;
  channel: TextChannel;
  now: () => number;
}

export interface HookResult {
  continue?: boolean;
  hookSpecificOutput?: {
    hookEventName: "PreToolUse";
    permissionDecision: "deny";
    permissionDecisionReason: string;
  };
}

const MAX_PER_CHANNEL = 50;
const MIN_DELAY_SECONDS = 60;
const MAX_DELAY_SECONDS = 3600;
const DEFAULT_TTL_SECONDS = 3600;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function isScheduleWakeupInput(x: unknown): x is { delaySeconds: number; prompt: string; reason?: string } {
  return typeof x === "object" && x !== null
    && typeof (x as { delaySeconds?: unknown }).delaySeconds === "number"
    && typeof (x as { prompt?: unknown }).prompt === "string";
}

export function handleScheduleWakeup(input: unknown, deps: HookDeps): HookResult {
  if (!isScheduleWakeupInput(input)) {
    return deny("Invalid ScheduleWakeup input — expected {delaySeconds, prompt}");
  }

  const total = countSchedulesByChannel(deps.channelId) + countCronsByChannel(deps.channelId);
  if (total >= MAX_PER_CHANNEL) {
    return deny(`Rate limit: this channel already has ${total} pending schedules/crons (max ${MAX_PER_CHANNEL}). Cancel some via /schedules before adding more.`);
  }

  const now = deps.now();
  const delayMs = clamp(input.delaySeconds, MIN_DELAY_SECONDS, MAX_DELAY_SECONDS) * 1000;
  const fireAt = now + delayMs;
  const id = `sch_${randomUUID().slice(0, 8)}`;

  insertSchedule({
    id,
    channel_id: deps.channelId,
    fire_at: fireAt,
    prompt: input.prompt,
    reason: input.reason ?? null,
    source: "schedule_wakeup",
    ttl_seconds: DEFAULT_TTL_SECONDS,
    created_at: now,
  });

  const fireIso = new Date(fireAt).toISOString();
  return deny(
    `Next wakeup scheduled for ${fireIso} (in ${Math.round(delayMs / 1000)}s). ` +
    `Bot will re-invoke you when the wakeup fires. (id: ${id})`,
  );
}

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
