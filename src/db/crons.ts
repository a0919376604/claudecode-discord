import type Database from "better-sqlite3";
import { getDb } from "./database.js";

export interface CronRow {
  id: string;
  channel_id: string;
  cron_expr: string;
  prompt: string;
  name: string | null;
  next_fire: number;
  last_fire: number | null;
  created_at: number;
}

let dbOverride: Database.Database | null = null;
export function __setDbForTests(db: Database.Database | null): void { dbOverride = db; }
function db(): Database.Database { return dbOverride ?? getDb(); }

export function insertCron(row: CronRow): void {
  db().prepare(`
    INSERT INTO crons (id, channel_id, cron_expr, prompt, name, next_fire, last_fire, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.id, row.channel_id, row.cron_expr, row.prompt, row.name, row.next_fire, row.last_fire, row.created_at);
}

export function listCronsByChannel(channelId: string): CronRow[] {
  return db().prepare(`SELECT * FROM crons WHERE channel_id = ? ORDER BY next_fire ASC`).all(channelId) as CronRow[];
}

export function findDueCrons(now: number): CronRow[] {
  return db().prepare(`SELECT * FROM crons WHERE next_fire <= ? ORDER BY next_fire ASC`).all(now) as CronRow[];
}

export function updateCronFire(id: string, lastFire: number, nextFire: number): void {
  db().prepare(`UPDATE crons SET last_fire = ?, next_fire = ? WHERE id = ?`).run(lastFire, nextFire, id);
}

export function deleteCronById(id: string): boolean {
  const result = db().prepare(`DELETE FROM crons WHERE id = ?`).run(id);
  return result.changes > 0;
}

export function countCronsByChannel(channelId: string): number {
  const row = db().prepare(`SELECT COUNT(*) as n FROM crons WHERE channel_id = ?`).get(channelId) as { n: number };
  return row.n;
}
