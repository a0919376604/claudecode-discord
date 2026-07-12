import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { handleScheduleWakeup } from "../../src/hooks/schedule-wakeup.js";
import { runTick } from "../../src/scheduler/tick.js";
import { WakeupWatcher } from "../../src/wakeup/watcher.js";
import { __setDbForTests as setSchedDb, listSchedulesByChannel } from "../../src/db/schedules.js";
import { __setDbForTests as setCronsDb } from "../../src/db/crons.js";

const CHANNEL = "123456789012345678";

function setupDb() {
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

describe("Schedule end-to-end pipeline", () => {
  beforeEach(() => setupDb());

  it("Claude ScheduleWakeup → DB → tick → wakeup file → WakeupWatcher → wakeUp()", async () => {
    // Setup tmp wakeup dir + spy on wakeUp
    const wakeupDir = await fs.mkdtemp(path.join(os.tmpdir(), "e2e-wakeup-"));
    const wakeUpSpy = vi.fn().mockResolvedValue(undefined);

    try {
      // 1. Simulate Claude calling ScheduleWakeup — the hook processes it
      const NOW = 1_700_000_000_000;
      const hookResult = handleScheduleWakeup(
        { delaySeconds: 60, prompt: "check autoplay", reason: "5min poll" },
        { channelId: CHANNEL, channel: {} as never, now: () => NOW },
      );
      expect(hookResult.hookSpecificOutput?.permissionDecision).toBe("deny");
      const dbRows = listSchedulesByChannel(CHANNEL);
      expect(dbRows).toHaveLength(1);

      // 2. Fast-forward clock to fire_at
      const fireAt = dbRows[0].fire_at;
      await runTick({
        now: fireAt,
        wakeupDir,
        discordClient: {} as never,
        log: () => {},
      });

      // 3. Verify wakeup file was written
      const files = (await fs.readdir(wakeupDir)).filter((n) => n.endsWith(".json"));
      expect(files).toHaveLength(1);
      const payload = JSON.parse(await fs.readFile(path.join(wakeupDir, files[0]), "utf-8"));
      expect(payload.channel_id).toBe(CHANNEL);
      expect(payload.prompt).toBe("check autoplay");
      expect(payload.source).toBe("schedule_wakeup");

      // 4. Verify DB row was deleted
      expect(listSchedulesByChannel(CHANNEL)).toHaveLength(0);

      // 5. Hand-off to WakeupWatcher
      const watcher = new WakeupWatcher({
        wakeupDir,
        legacyDir: "/nonexistent",
        isChannelRegistered: (id) => id === CHANNEL,
        hasActiveSession: () => false,  // idle → direct wakeUp
        wakeUp: wakeUpSpy,
        sendPassiveEmbed: async () => {},
      });

      // Scan once to process the file we already dropped
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(fireAt);
      try {
        await watcher["scanWakeupDir"]?.();
      } finally {
        nowSpy.mockRestore();
      }

      // 6. wakeUp should have been called with the right args
      expect(wakeUpSpy).toHaveBeenCalledOnce();
      expect(wakeUpSpy).toHaveBeenCalledWith(CHANNEL, "check autoplay", "schedule_wakeup");

      // 7. File was cleaned up by watcher
      expect((await fs.readdir(wakeupDir)).filter((n) => n.endsWith(".json"))).toHaveLength(0);
    } finally {
      await fs.rm(wakeupDir, { recursive: true, force: true });
    }
  });
});
