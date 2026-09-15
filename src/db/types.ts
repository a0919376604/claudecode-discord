export type SessionStatus = "online" | "offline" | "waiting" | "idle";

export interface Project {
  channel_id: string;
  project_path: string;
  guild_id: string;
  auto_approve: number; // 0 or 1
  source_path: string | null; // NULL for /register, absolute path for /worktree
  backend: "claude" | "codex";
  created_at: string;
}

export interface Session {
  id: string;
  channel_id: string;
  session_id: string | null; // Claude Agent SDK session ID
  status: SessionStatus;
  last_activity: string | null;
  created_at: string;
}

/**
 * Tracks codex background runs launched via Claude's Bash tool, so wakeup
 * events can be routed back to the originating Discord channel without
 * relying on `/tmp/run-plan-meta-<slot>.txt` (which Claude's manual retry
 * pattern is known to rewrite and drop `channel_id=` from).
 *
 * Populated by the PreToolUse Bash hook when Claude runs a command that
 * matches the codex-launch pattern. Consumed by the legacy adapter (via
 * resolveChannelForSlot fallback) and the PID poller.
 */
export interface RunPlanSlotRow {
  slot: string;
  channel_id: string;
  launched_at: number; // unix ms
}

export type { WakeupQueueRow } from "../wakeup/types.js";
export type { ScheduleRow } from "./schedules.js";
export type { CronRow } from "./crons.js";
