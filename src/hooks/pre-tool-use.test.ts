import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import type { TextChannel } from "discord.js";
import { createPreToolUseHook } from "./pre-tool-use.js";
import { __setDbForTests as setSchedDb, listSchedulesByChannel } from "../db/schedules.js";
import { __setDbForTests as setCronsDb, listCronsByChannel } from "../db/crons.js";

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

describe("PreToolUse hook — CronCreate", () => {
  beforeEach(() => setup());

  it("creates cron with valid expression", async () => {
    const channel = {} as TextChannel;
    const hook = createPreToolUseHook({ channelId: CHANNEL, channel, now: () => Date.UTC(2026, 6, 13, 0, 0, 0) });

    const output = await hook(
      { hook_event_name: "PreToolUse", tool_name: "CronCreate",
        tool_input: { schedule: "0 9 * * *", prompt: "morning PR", name: "morning" },
        tool_use_id: "t", session_id: "s", transcript_path: "/t", cwd: "/t" },
      "t", { signal: new AbortController().signal },
    );

    expect(output.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(output.hookSpecificOutput?.permissionDecisionReason).toMatch(/Cron created/);
    const rows = listCronsByChannel(CHANNEL);
    expect(rows).toHaveLength(1);
    expect(rows[0].cron_expr).toBe("0 9 * * *");
    expect(rows[0].name).toBe("morning");
    expect(rows[0].next_fire).toBe(Date.UTC(2026, 6, 13, 9, 0, 0));
  });

  it("rejects invalid cron expression", async () => {
    const channel = {} as TextChannel;
    const hook = createPreToolUseHook({ channelId: CHANNEL, channel, now: () => 1_700_000_000_000 });
    const output = await hook(
      { hook_event_name: "PreToolUse", tool_name: "CronCreate",
        tool_input: { schedule: "not a cron", prompt: "x" },
        tool_use_id: "t", session_id: "s", transcript_path: "/t", cwd: "/t" },
      "t", { signal: new AbortController().signal },
    );
    expect(output.hookSpecificOutput?.permissionDecisionReason).toMatch(/invalid|parse/i);
    expect(listCronsByChannel(CHANNEL)).toHaveLength(0);
  });
});

describe("PreToolUse hook — CronList", () => {
  beforeEach(() => setup());

  it("returns formatted list of channel's crons", async () => {
    // Insert 2 crons directly via DB
    const now = Date.UTC(2026, 6, 13, 0, 0, 0);
    const db = (await import("../db/crons.js"));
    db.insertCron({ id: "cron_a", channel_id: CHANNEL, cron_expr: "0 9 * * *", prompt: "morning", name: "morning", next_fire: now + 9 * 3600_000, last_fire: null, created_at: now });
    db.insertCron({ id: "cron_b", channel_id: CHANNEL, cron_expr: "0 18 * * *", prompt: "evening", name: null, next_fire: now + 18 * 3600_000, last_fire: null, created_at: now });

    const channel = {} as TextChannel;
    const hook = createPreToolUseHook({ channelId: CHANNEL, channel, now: () => now });
    const output = await hook(
      { hook_event_name: "PreToolUse", tool_name: "CronList",
        tool_input: {}, tool_use_id: "t",
        session_id: "s", transcript_path: "/t", cwd: "/t" },
      "t", { signal: new AbortController().signal },
    );

    const reason = output.hookSpecificOutput?.permissionDecisionReason ?? "";
    expect(reason).toContain("cron_a");
    expect(reason).toContain("cron_b");
    expect(reason).toContain("0 9 * * *");
  });
});

describe("PreToolUse hook — CronDelete", () => {
  beforeEach(() => setup());

  it("deletes existing cron", async () => {
    const now = 1_700_000_000_000;
    const db = (await import("../db/crons.js"));
    db.insertCron({ id: "cron_a", channel_id: CHANNEL, cron_expr: "* * * * *", prompt: "x", name: null, next_fire: now, last_fire: null, created_at: now });

    const channel = {} as TextChannel;
    const hook = createPreToolUseHook({ channelId: CHANNEL, channel, now: () => now });
    const output = await hook(
      { hook_event_name: "PreToolUse", tool_name: "CronDelete",
        tool_input: { id: "cron_a" }, tool_use_id: "t",
        session_id: "s", transcript_path: "/t", cwd: "/t" },
      "t", { signal: new AbortController().signal },
    );

    expect(output.hookSpecificOutput?.permissionDecisionReason).toMatch(/Deleted cron_a/);
    expect(listCronsByChannel(CHANNEL)).toHaveLength(0);
  });

  it("returns not-found for nonexistent id", async () => {
    const channel = {} as TextChannel;
    const hook = createPreToolUseHook({ channelId: CHANNEL, channel, now: () => 1_700_000_000_000 });
    const output = await hook(
      { hook_event_name: "PreToolUse", tool_name: "CronDelete",
        tool_input: { id: "cron_nonexistent" }, tool_use_id: "t",
        session_id: "s", transcript_path: "/t", cwd: "/t" },
      "t", { signal: new AbortController().signal },
    );
    expect(output.hookSpecificOutput?.permissionDecisionReason).toMatch(/not found/i);
  });
});

describe("PreToolUse hook — PushNotification", () => {
  beforeEach(() => setup());

  it("sends channel.send message and returns deny with confirmation", async () => {
    const sendSpy = vi.fn().mockResolvedValue(undefined);
    const channel = { send: sendSpy } as unknown as TextChannel;
    const hook = createPreToolUseHook({ channelId: CHANNEL, channel, now: () => 1_700_000_000_000 });

    const output = await hook(
      { hook_event_name: "PreToolUse", tool_name: "PushNotification",
        tool_input: { message: "任務 X 完成" }, tool_use_id: "t",
        session_id: "s", transcript_path: "/t", cwd: "/t" },
      "t", { signal: new AbortController().signal },
    );

    expect(sendSpy).toHaveBeenCalledOnce();
    expect(sendSpy.mock.calls[0][0]).toEqual({ content: "任務 X 完成" });
    expect(output.hookSpecificOutput?.permissionDecisionReason).toMatch(/Notification sent/);
  });

  it("rejects on missing message", async () => {
    const sendSpy = vi.fn();
    const channel = { send: sendSpy } as unknown as TextChannel;
    const hook = createPreToolUseHook({ channelId: CHANNEL, channel, now: () => 1_700_000_000_000 });
    const output = await hook(
      { hook_event_name: "PreToolUse", tool_name: "PushNotification",
        tool_input: {}, tool_use_id: "t",
        session_id: "s", transcript_path: "/t", cwd: "/t" },
      "t", { signal: new AbortController().signal },
    );
    expect(sendSpy).not.toHaveBeenCalled();
    expect(output.hookSpecificOutput?.permissionDecisionReason).toMatch(/invalid|expected/i);
  });
});
