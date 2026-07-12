import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  insertCron, findDueCrons, updateCronFire, listCronsByChannel,
  deleteCronById, __setDbForTests as setCronsDb,
} from "./crons.js";

const CHANNEL = "123456789012345678";
const now = 1_700_000_000_000;

function setup(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE projects (channel_id TEXT PRIMARY KEY, project_path TEXT, guild_id TEXT);
    CREATE TABLE crons (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      cron_expr TEXT NOT NULL,
      prompt TEXT NOT NULL,
      name TEXT,
      next_fire INTEGER NOT NULL,
      last_fire INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (channel_id) REFERENCES projects(channel_id) ON DELETE CASCADE
    );
    CREATE INDEX idx_crons_next_fire ON crons(next_fire);
  `);
  db.prepare("INSERT INTO projects (channel_id, project_path, guild_id) VALUES (?, '/x', 'g')").run(CHANNEL);
  setCronsDb(db);
  return db;
}

describe("crons table", () => {
  beforeEach(() => setup());

  it("insert + list", () => {
    insertCron({ id: "cron_a", channel_id: CHANNEL, cron_expr: "0 9 * * *", prompt: "morning", name: null, next_fire: now + 3600_000, last_fire: null, created_at: now });
    expect(listCronsByChannel(CHANNEL)).toHaveLength(1);
  });

  it("findDueCrons only returns rows where next_fire <= now", () => {
    insertCron({ id: "cron_past", channel_id: CHANNEL, cron_expr: "* * * * *", prompt: "p", name: null, next_fire: now - 1000, last_fire: null, created_at: now });
    insertCron({ id: "cron_future", channel_id: CHANNEL, cron_expr: "* * * * *", prompt: "f", name: null, next_fire: now + 60_000, last_fire: null, created_at: now });
    const due = findDueCrons(now);
    expect(due.map((r) => r.id)).toEqual(["cron_past"]);
  });

  it("updateCronFire updates last_fire and next_fire", () => {
    insertCron({ id: "cron_a", channel_id: CHANNEL, cron_expr: "* * * * *", prompt: "p", name: null, next_fire: now - 1000, last_fire: null, created_at: now });
    updateCronFire("cron_a", now, now + 60_000);
    const rows = listCronsByChannel(CHANNEL);
    expect(rows[0].last_fire).toBe(now);
    expect(rows[0].next_fire).toBe(now + 60_000);
  });

  it("deleteCronById returns bool", () => {
    insertCron({ id: "cron_a", channel_id: CHANNEL, cron_expr: "* * * * *", prompt: "p", name: null, next_fire: now, last_fire: null, created_at: now });
    expect(deleteCronById("cron_a")).toBe(true);
    expect(deleteCronById("cron_a")).toBe(false);
  });
});
