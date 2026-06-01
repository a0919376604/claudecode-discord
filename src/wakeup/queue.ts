import type Database from "better-sqlite3";
import { getDb } from "../db/database.js";
import { deriveDedupeKey, type WakeupPayload, type WakeupQueueRow } from "./types.js";

// Test seam — production code uses getDb(); tests inject in-memory db.
let injectedDb: Database.Database | null = null;
export function setQueueDb(db: Database.Database | null): void {
  injectedDb = db;
}
function db(): Database.Database {
  return injectedDb ?? getDb();
}

export function enqueueWakeup(payload: WakeupPayload): void {
  const dedupeKey = deriveDedupeKey(payload.source, payload.metadata, payload.created_at);
  // ON CONFLICT replaces the prior row for (channel, dedupe_key) — newest wins.
  db().prepare(`
    INSERT INTO wakeup_queue (channel_id, source, payload_json, queued_at, dedupe_key)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(channel_id, dedupe_key) DO UPDATE SET
      source       = excluded.source,
      payload_json = excluded.payload_json,
      queued_at    = excluded.queued_at
  `).run(
    payload.channel_id,
    payload.source,
    JSON.stringify(payload),
    Date.now(),
    dedupeKey,
  );
}

export function peekOldest(channelId: string): WakeupQueueRow | null {
  const row = db().prepare(
    "SELECT * FROM wakeup_queue WHERE channel_id = ? ORDER BY queued_at ASC LIMIT 1",
  ).get(channelId) as WakeupQueueRow | undefined;
  return row ?? null;
}

export function drainOldest(channelId: string): WakeupQueueRow | null {
  const row = peekOldest(channelId);
  if (!row) return null;
  db().prepare("DELETE FROM wakeup_queue WHERE id = ?").run(row.id);
  return row;
}

export function deleteByChannel(channelId: string): void {
  db().prepare("DELETE FROM wakeup_queue WHERE channel_id = ?").run(channelId);
}

export function countByChannel(channelId: string): number {
  const row = db().prepare(
    "SELECT COUNT(*) as n FROM wakeup_queue WHERE channel_id = ?",
  ).get(channelId) as { n: number };
  return row.n;
}
