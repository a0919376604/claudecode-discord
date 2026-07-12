import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { formatScheduleList } from "./schedules.js";
import { __setDbForTests as setSchedDb, insertSchedule } from "../../db/schedules.js";
import { __setDbForTests as setCronsDb, insertCron } from "../../db/crons.js";

const CHANNEL = "123456789012345678";
const NOW = 1_700_000_000_000;

function setup() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE projects (channel_id TEXT PRIMARY KEY, project_path TEXT, guild_id TEXT);
    CREATE TABLE schedules (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, fire_at INTEGER NOT NULL, prompt TEXT NOT NULL, reason TEXT, source TEXT NOT NULL, ttl_seconds INTEGER NOT NULL DEFAULT 3600, created_at INTEGER NOT NULL);
    CREATE TABLE crons (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, cron_expr TEXT NOT NULL, prompt TEXT NOT NULL, name TEXT, next_fire INTEGER NOT NULL, last_fire INTEGER, created_at INTEGER NOT NULL);
  `);
  db.prepare("INSERT INTO projects (channel_id, project_path, guild_id) VALUES (?, '/x', 'g')").run(CHANNEL);
  setSchedDb(db); setCronsDb(db);
}

describe("formatScheduleList", () => {
  beforeEach(() => setup());

  it("shows empty state when no schedules", () => {
    const output = formatScheduleList(CHANNEL, NOW);
    expect(output).toMatch(/no schedules|沒有排程/i);
  });

  it("shows both schedules and crons with relative times", () => {
    insertSchedule({ id: "sch_a", channel_id: CHANNEL, fire_at: NOW + 132_000, prompt: "Check R-018", reason: null, source: "schedule_wakeup", ttl_seconds: 3600, created_at: NOW });
    insertCron({ id: "cron_b", channel_id: CHANNEL, cron_expr: "0 9 * * *", prompt: "morning", name: "morning", next_fire: NOW + 9200_000, last_fire: null, created_at: NOW });

    const output = formatScheduleList(CHANNEL, NOW);
    expect(output).toContain("sch_a");
    expect(output).toContain("cron_b");
    expect(output).toMatch(/2m 12s/);  // 132s = 2m 12s
    expect(output).toContain("Check R-018");
    expect(output).toContain("0 9 * * *");
  });

  it("truncates long prompts", () => {
    insertSchedule({ id: "sch_long", channel_id: CHANNEL, fire_at: NOW + 60_000,
      prompt: "x".repeat(200), reason: null, source: "schedule_wakeup", ttl_seconds: 3600, created_at: NOW });
    const output = formatScheduleList(CHANNEL, NOW);
    expect(output).toContain("...");
    expect(output).not.toContain("x".repeat(100));  // truncated
  });
});
