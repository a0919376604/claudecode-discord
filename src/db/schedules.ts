import type Database from "better-sqlite3";
import { getDb } from "./database.js";

export interface ScheduleRow {
  id: string;
  channel_id: string;
  fire_at: number;
  prompt: string;
  reason: string | null;
  source: string;
  ttl_seconds: number;
  created_at: number;
}

let dbOverride: Database.Database | null = null;

/** Test-only hook — do NOT call from production code. */
export function __setDbForTests(db: Database.Database | null): void {
  dbOverride = db;
}

function db(): Database.Database {
  return dbOverride ?? getDb();
}

export function insertSchedule(row: ScheduleRow): void {
  db().prepare(`
    INSERT INTO schedules (id, channel_id, fire_at, prompt, reason, source, ttl_seconds, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.id, row.channel_id, row.fire_at, row.prompt, row.reason, row.source, row.ttl_seconds, row.created_at);
}

export function listSchedulesByChannel(channelId: string): ScheduleRow[] {
  return db().prepare(`SELECT * FROM schedules WHERE channel_id = ? ORDER BY fire_at ASC`).all(channelId) as ScheduleRow[];
}

export function findDueSchedules(now: number): ScheduleRow[] {
  return db().prepare(`
    SELECT * FROM schedules
    WHERE fire_at <= ? AND (created_at + ttl_seconds * 1000) >= ?
    ORDER BY fire_at ASC
  `).all(now, now) as ScheduleRow[];
}

export function findExpiredSchedules(now: number): ScheduleRow[] {
  return db().prepare(`
    SELECT * FROM schedules
    WHERE (created_at + ttl_seconds * 1000) < ?
  `).all(now) as ScheduleRow[];
}

export function deleteScheduleById(id: string): boolean {
  const result = db().prepare(`DELETE FROM schedules WHERE id = ?`).run(id);
  return result.changes > 0;
}

export function countSchedulesByChannel(channelId: string): number {
  const row = db().prepare(`SELECT COUNT(*) as n FROM schedules WHERE channel_id = ?`).get(channelId) as { n: number };
  return row.n;
}
