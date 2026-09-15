import Database from "better-sqlite3";
import path from "node:path";
import type { Project, RunPlanSlotRow, Session, SessionStatus } from "./types.js";

const DB_PATH = path.join(process.cwd(), "data.db");

let db: Database.Database;

export function initDatabase(): void {
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      channel_id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      auto_approve INTEGER DEFAULT 0,
      source_path TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      channel_id TEXT REFERENCES projects(channel_id) ON DELETE CASCADE,
      session_id TEXT,
      status TEXT DEFAULT 'offline',
      last_activity TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS wakeup_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL,
      source TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      queued_at INTEGER NOT NULL,
      dedupe_key TEXT,
      UNIQUE(channel_id, dedupe_key)
    );
    CREATE INDEX IF NOT EXISTS idx_wakeup_queue_channel ON wakeup_queue(channel_id, queued_at);

    CREATE TABLE IF NOT EXISTS schedules (
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
    CREATE INDEX IF NOT EXISTS idx_schedules_fire_at ON schedules(fire_at);
    CREATE INDEX IF NOT EXISTS idx_schedules_channel ON schedules(channel_id);

    CREATE TABLE IF NOT EXISTS crons (
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
    CREATE INDEX IF NOT EXISTS idx_crons_next_fire ON crons(next_fire);
    CREATE INDEX IF NOT EXISTS idx_crons_channel ON crons(channel_id);

    -- Bot-recorded codex background runs. Populated by the PreToolUse
    -- Bash hook when Claude launches codex, so wakeup routing does not
    -- depend on Claude preserving /tmp/run-plan-meta-<slot>.txt's
    -- channel_id line across manual retry cycles. Consumed by the
    -- legacy adapter (as a fallback channel resolver) and the PID
    -- poller (which fires wakeups when codex dies without a done marker).
    -- NO FK on channel_id — codex can be launched from an unregistered
    -- worktree cwd but still route back to a valid channel via the
    -- Claude session's WAKEUP_CHANNEL_ID env var.
    CREATE TABLE IF NOT EXISTS run_plan_slots (
      slot TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      launched_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_run_plan_slots_channel ON run_plan_slots(channel_id);
  `);

  // Migration: add source_path column for installations created before /worktree.
  // Safe to re-run; only ALTERs when the column is missing.
  const cols = db
    .prepare("PRAGMA table_info(projects)")
    .all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "source_path")) {
    db.exec("ALTER TABLE projects ADD COLUMN source_path TEXT");
  }

  // Migration: add backend column for multi-agent support.
  // Safe to re-run; only ALTERs when the column is missing.
  if (!cols.some((c) => c.name === "backend")) {
    db.exec("ALTER TABLE projects ADD COLUMN backend TEXT NOT NULL DEFAULT 'claude'");
  }
}

export function getDb(): Database.Database {
  return db;
}

// Project queries
export function registerProject(
  channelId: string,
  projectPath: string,
  guildId: string,
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO projects (channel_id, project_path, guild_id)
    VALUES (?, ?, ?)
  `);
  stmt.run(channelId, projectPath, guildId);
}

export function registerWorktreeProject(
  channelId: string,
  projectPath: string,
  guildId: string,
  sourcePath: string,
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO projects (channel_id, project_path, guild_id, source_path)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(channelId, projectPath, guildId, sourcePath);
}

export function unregisterProject(channelId: string): void {
  db.prepare("DELETE FROM sessions WHERE channel_id = ?").run(channelId);
  db.prepare("DELETE FROM projects WHERE channel_id = ?").run(channelId);
}

export function getProject(channelId: string): Project | undefined {
  return db
    .prepare("SELECT * FROM projects WHERE channel_id = ?")
    .get(channelId) as Project | undefined;
}

/**
 * Reverse lookup: find the project (and thus channel_id) that owns a
 * given filesystem path. Used by the wakeup legacy-adapter as a
 * last-resort fallback when a run-plan meta file lacks channel_id.
 * Returns undefined if no exact-match project exists.
 */
export function getProjectByPath(projectPath: string): Project | undefined {
  return db
    .prepare("SELECT * FROM projects WHERE project_path = ?")
    .get(projectPath) as Project | undefined;
}

export function getAllProjects(guildId: string): Project[] {
  return db
    .prepare("SELECT * FROM projects WHERE guild_id = ?")
    .all(guildId) as Project[];
}

export function setAutoApprove(
  channelId: string,
  autoApprove: boolean,
): void {
  db.prepare("UPDATE projects SET auto_approve = ? WHERE channel_id = ?").run(
    autoApprove ? 1 : 0,
    channelId,
  );
}

export function setBackend(
  channelId: string,
  backend: "claude" | "codex",
): void {
  db.prepare("UPDATE projects SET backend = ? WHERE channel_id = ?").run(
    backend,
    channelId,
  );
}

// Session queries
export function upsertSession(
  id: string,
  channelId: string,
  sessionId: string | null,
  status: SessionStatus,
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO sessions (id, channel_id, session_id, status, last_activity)
    VALUES (?, ?, ?, ?, datetime('now'))
  `);
  stmt.run(id, channelId, sessionId, status);
}

export function getSession(channelId: string): Session | undefined {
  return db
    .prepare(
      "SELECT * FROM sessions WHERE channel_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(channelId) as Session | undefined;
}

export function updateSessionStatus(
  channelId: string,
  status: SessionStatus,
): void {
  db.prepare(
    "UPDATE sessions SET status = ?, last_activity = datetime('now') WHERE channel_id = ?",
  ).run(status, channelId);
}

export function clearSessionId(channelId: string): void {
  db.prepare("UPDATE sessions SET session_id = NULL WHERE channel_id = ?").run(
    channelId,
  );
}

export function getAllSessions(guildId: string): (Session & { project_path: string })[] {
  return db
    .prepare(`
      SELECT s.*, p.project_path FROM sessions s
      JOIN projects p ON s.channel_id = p.channel_id
      WHERE p.guild_id = ?
    `)
    .all(guildId) as (Session & { project_path: string })[];
}

// ─── run_plan_slots queries ──────────────────────────────────────────────
// See RunPlanSlotRow docstring in db/types.ts for the rationale.

/**
 * Record (or update) a codex slot's owning Discord channel. Uses REPLACE
 * so a re-launch of the same slot (retry, restart) refreshes the timestamp
 * without needing a separate update path.
 */
export function upsertRunPlanSlot(slot: string, channelId: string, launchedAt: number): void {
  db.prepare(
    "INSERT OR REPLACE INTO run_plan_slots (slot, channel_id, launched_at) VALUES (?, ?, ?)",
  ).run(slot, channelId, launchedAt);
}

export function getRunPlanSlot(slot: string): RunPlanSlotRow | undefined {
  return db
    .prepare("SELECT slot, channel_id, launched_at FROM run_plan_slots WHERE slot = ?")
    .get(slot) as RunPlanSlotRow | undefined;
}

export function listRunPlanSlots(): RunPlanSlotRow[] {
  return db
    .prepare("SELECT slot, channel_id, launched_at FROM run_plan_slots ORDER BY launched_at DESC")
    .all() as RunPlanSlotRow[];
}

export function deleteRunPlanSlot(slot: string): void {
  db.prepare("DELETE FROM run_plan_slots WHERE slot = ?").run(slot);
}
