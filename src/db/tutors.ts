import type Database from "better-sqlite3";
import { getDb } from "./database.js";
import type { Tutor } from "./types.js";

let dbOverride: Database.Database | null = null;
export function __setDbForTests(db: Database.Database | null): void { dbOverride = db; }
function db(): Database.Database { return dbOverride ?? getDb(); }

export function getTutor(channelId: string): Tutor | undefined {
  return db().prepare("SELECT * FROM tutors WHERE channel_id = ?").get(channelId) as Tutor | undefined;
}

export function upsertTutor(row: Omit<Tutor, "deeptutor_session_id" | "created_at">): void {
  db().prepare(`
    INSERT INTO tutors (channel_id, subject, goal, level, deadline, daily_minutes, menu, push_time, timezone, language, created_at)
    VALUES (@channel_id, @subject, @goal, @level, @deadline, @daily_minutes, @menu, @push_time, @timezone, @language, @created_at)
    ON CONFLICT(channel_id) DO UPDATE SET
      subject = excluded.subject, goal = excluded.goal, level = excluded.level,
      deadline = excluded.deadline, daily_minutes = excluded.daily_minutes,
      menu = excluded.menu, push_time = excluded.push_time,
      timezone = excluded.timezone, language = excluded.language
  `).run({ ...row, created_at: Date.now() });
}

export function setTutorSession(channelId: string, sessionId: string | null): void {
  db().prepare("UPDATE tutors SET deeptutor_session_id = ? WHERE channel_id = ?").run(sessionId, channelId);
}

export function deleteTutor(channelId: string): void {
  db().prepare("DELETE FROM tutors WHERE channel_id = ?").run(channelId);
}
