import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import type { TextChannel } from "discord.js";
import { createPreToolUseHook } from "./pre-tool-use.js";
import { __setDbForTests as setSchedDb, listSchedulesByChannel } from "../db/schedules.js";
import { __setDbForTests as setCronsDb } from "../db/crons.js";

const CHANNEL = "123456789012345678";
const NOW = 1_700_000_000_000;

function setup() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE projects (channel_id TEXT PRIMARY KEY, project_path TEXT, guild_id TEXT);
    CREATE TABLE schedules (
      id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, fire_at INTEGER NOT NULL,
      prompt TEXT NOT NULL, reason TEXT, source TEXT NOT NULL,
      ttl_seconds INTEGER NOT NULL DEFAULT 3600, created_at INTEGER NOT NULL);
    CREATE TABLE crons (
      id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, cron_expr TEXT NOT NULL,
      prompt TEXT NOT NULL, name TEXT, next_fire INTEGER NOT NULL,
      last_fire INTEGER, created_at INTEGER NOT NULL);
  `);
  db.prepare("INSERT INTO projects (channel_id, project_path, guild_id) VALUES (?, '/x', 'g')").run(CHANNEL);
  setSchedDb(db); setCronsDb(db);
  return db;
}

describe("PreToolUse hook — ScheduleWakeup", () => {
  beforeEach(() => setup());

  it("inserts a schedule row and returns deny with informational reason", async () => {
    const channel = {} as TextChannel;
    const hook = createPreToolUseHook({
      channelId: CHANNEL,
      channel,
      now: () => NOW,
    });

    const output = await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "ScheduleWakeup",
        tool_input: { delaySeconds: 300, prompt: "Check R-018", reason: "5min poll" },
        tool_use_id: "toolu_x",
        session_id: "sess",
        transcript_path: "/tmp/t",
        cwd: "/tmp",
      },
      "toolu_x",
      { signal: new AbortController().signal },
    );

    // Deny + reason (main strategy)
    expect(output.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(output.hookSpecificOutput?.permissionDecisionReason).toMatch(/Next wakeup scheduled/);
    expect(output.hookSpecificOutput?.permissionDecisionReason).toMatch(/sch_/);

    // DB effect
    const rows = listSchedulesByChannel(CHANNEL);
    expect(rows).toHaveLength(1);
    expect(rows[0].fire_at).toBe(NOW + 300_000);
    expect(rows[0].prompt).toBe("Check R-018");
    expect(rows[0].reason).toBe("5min poll");
    expect(rows[0].source).toBe("schedule_wakeup");
  });

  it("clamps delaySeconds to [60, 3600]", async () => {
    const channel = {} as TextChannel;
    const hook = createPreToolUseHook({ channelId: CHANNEL, channel, now: () => NOW });

    await hook(
      { hook_event_name: "PreToolUse", tool_name: "ScheduleWakeup",
        tool_input: { delaySeconds: 10, prompt: "x" }, tool_use_id: "t1",
        session_id: "s", transcript_path: "/t", cwd: "/t" },
      "t1", { signal: new AbortController().signal },
    );
    await hook(
      { hook_event_name: "PreToolUse", tool_name: "ScheduleWakeup",
        tool_input: { delaySeconds: 10_000, prompt: "y" }, tool_use_id: "t2",
        session_id: "s", transcript_path: "/t", cwd: "/t" },
      "t2", { signal: new AbortController().signal },
    );

    const rows = listSchedulesByChannel(CHANNEL);
    expect(rows.find((r) => r.prompt === "x")!.fire_at).toBe(NOW + 60_000);
    expect(rows.find((r) => r.prompt === "y")!.fire_at).toBe(NOW + 3600_000);
  });

  it("rejects when total schedules + crons >= 50 (soft rate limit)", async () => {
    // pre-fill 50 rows
    const db = setup();
    for (let i = 0; i < 50; i++) {
      db.prepare(`INSERT INTO schedules (id, channel_id, fire_at, prompt, source, ttl_seconds, created_at) VALUES (?, ?, ?, ?, 'schedule_wakeup', 3600, ?)`)
        .run(`sch_${i}`, CHANNEL, NOW + 60_000, "x", NOW);
    }

    const channel = {} as TextChannel;
    const hook = createPreToolUseHook({ channelId: CHANNEL, channel, now: () => NOW });
    const output = await hook(
      { hook_event_name: "PreToolUse", tool_name: "ScheduleWakeup",
        tool_input: { delaySeconds: 300, prompt: "over-limit" }, tool_use_id: "t",
        session_id: "s", transcript_path: "/t", cwd: "/t" },
      "t", { signal: new AbortController().signal },
    );

    expect(output.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(output.hookSpecificOutput?.permissionDecisionReason).toMatch(/rate limit|too many/i);
    expect(listSchedulesByChannel(CHANNEL)).toHaveLength(50);  // no new row
  });

  it("passes through unknown tools (returns empty continue)", async () => {
    const channel = {} as TextChannel;
    const hook = createPreToolUseHook({ channelId: CHANNEL, channel, now: () => NOW });
    const output = await hook(
      { hook_event_name: "PreToolUse", tool_name: "Read",
        tool_input: { file_path: "/x" }, tool_use_id: "t",
        session_id: "s", transcript_path: "/t", cwd: "/t" },
      "t", { signal: new AbortController().signal },
    );
    // Nothing set → SDK treats as allow (default)
    expect(output).toEqual({ continue: true });
  });
});
