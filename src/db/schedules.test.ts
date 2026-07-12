import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  insertSchedule,
  findDueSchedules,
  findExpiredSchedules,
  listSchedulesByChannel,
  deleteScheduleById,
  __setDbForTests,
} from "./schedules.js";

const CHANNEL = "123456789012345678";
const now = 1_700_000_000_000;

function setup(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE projects (channel_id TEXT PRIMARY KEY, project_path TEXT, guild_id TEXT);
    CREATE TABLE schedules (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      fire_at INTEGER NOT NULL,
      prompt TEXT NOT NULL,
      reason TEXT,
      source TEXT NOT NULL,
      ttl_seconds INTEGER NOT NULL DEFAULT 3600,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (channel_id) REFERENCES projects(channel_id) ON DELETE CASCADE
    );
    CREATE INDEX idx_schedules_fire_at ON schedules(fire_at);
  `);
  db.prepare("INSERT INTO projects (channel_id, project_path, guild_id) VALUES (?, '/x', 'g')").run(CHANNEL);
  __setDbForTests(db);
  return db;
}

describe("schedules table", () => {
  beforeEach(() => setup());

  it("inserts and lists by channel", () => {
    insertSchedule({
      id: "sch_a", channel_id: CHANNEL, fire_at: now + 60_000,
      prompt: "check X", reason: null, source: "schedule_wakeup",
      ttl_seconds: 3600, created_at: now,
    });
    const rows = listSchedulesByChannel(CHANNEL);
    expect(rows).toHaveLength(1);
    expect(rows[0].prompt).toBe("check X");
  });

  it("findDueSchedules returns only rows where fire_at <= now AND not expired", () => {
    insertSchedule({ id: "sch_past", channel_id: CHANNEL, fire_at: now - 1_000, prompt: "due", reason: null, source: "schedule_wakeup", ttl_seconds: 3600, created_at: now - 500 });
    insertSchedule({ id: "sch_future", channel_id: CHANNEL, fire_at: now + 60_000, prompt: "not due", reason: null, source: "schedule_wakeup", ttl_seconds: 3600, created_at: now });
    insertSchedule({ id: "sch_expired", channel_id: CHANNEL, fire_at: now - 10_000, prompt: "expired", reason: null, source: "schedule_wakeup", ttl_seconds: 1, created_at: now - 10_000 });
    const due = findDueSchedules(now);
    expect(due.map((r) => r.id)).toEqual(["sch_past"]);
  });

  it("findExpiredSchedules returns rows past TTL", () => {
    insertSchedule({ id: "sch_expired", channel_id: CHANNEL, fire_at: now, prompt: "x", reason: null, source: "schedule_wakeup", ttl_seconds: 1, created_at: now - 10_000 });
    const expired = findExpiredSchedules(now);
    expect(expired).toHaveLength(1);
    expect(expired[0].id).toBe("sch_expired");
  });

  it("deleteScheduleById removes row and returns true", () => {
    insertSchedule({ id: "sch_a", channel_id: CHANNEL, fire_at: now, prompt: "x", reason: null, source: "schedule_wakeup", ttl_seconds: 3600, created_at: now });
    expect(deleteScheduleById("sch_a")).toBe(true);
    expect(listSchedulesByChannel(CHANNEL)).toHaveLength(0);
    expect(deleteScheduleById("sch_nonexistent")).toBe(false);
  });
});
