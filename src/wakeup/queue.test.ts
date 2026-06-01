import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { setQueueDb, enqueueWakeup, drainOldest, peekOldest, deleteByChannel, countByChannel } from "./queue.js";
import type { WakeupPayload } from "./types.js";

const samplePayload: WakeupPayload = {
  channel_id: "123456789012345678",
  prompt: "/run-plan status foo",
  source: "run-plan",
  metadata: { slot: "foo" },
  created_at: "2026-06-01T12:00:00Z",
  ttl_seconds: 86400,
};

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE wakeup_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL,
      source TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      queued_at INTEGER NOT NULL,
      dedupe_key TEXT,
      UNIQUE(channel_id, dedupe_key)
    );
    CREATE INDEX idx_wakeup_queue_channel ON wakeup_queue(channel_id, queued_at);
  `);
  return db;
}

describe("wakeup queue", () => {
  beforeEach(() => {
    setQueueDb(freshDb());
  });

  it("enqueues a wakeup and peeks it back", () => {
    enqueueWakeup(samplePayload);
    const row = peekOldest("123456789012345678");
    expect(row).not.toBeNull();
    expect(row!.source).toBe("run-plan");
    expect(JSON.parse(row!.payload_json).prompt).toBe(samplePayload.prompt);
  });

  it("dedupes by (channel, source, slot) — newest wins", () => {
    enqueueWakeup(samplePayload);
    enqueueWakeup({ ...samplePayload, prompt: "/run-plan status foo NEW" });
    expect(countByChannel("123456789012345678")).toBe(1);
    const row = peekOldest("123456789012345678");
    expect(JSON.parse(row!.payload_json).prompt).toBe("/run-plan status foo NEW");
  });

  it("keeps different slots distinct", () => {
    enqueueWakeup(samplePayload);
    enqueueWakeup({ ...samplePayload, metadata: { slot: "bar" } });
    expect(countByChannel("123456789012345678")).toBe(2);
  });

  it("drainOldest returns and removes oldest row", () => {
    enqueueWakeup(samplePayload);
    enqueueWakeup({ ...samplePayload, metadata: { slot: "bar" } });
    const first = drainOldest("123456789012345678");
    expect(first).not.toBeNull();
    expect(countByChannel("123456789012345678")).toBe(1);
  });

  it("drainOldest returns null when empty", () => {
    expect(drainOldest("123456789012345678")).toBeNull();
  });

  it("deleteByChannel wipes that channel only", () => {
    enqueueWakeup(samplePayload);
    enqueueWakeup({ ...samplePayload, channel_id: "987654321098765432", metadata: { slot: "z" } });
    deleteByChannel("123456789012345678");
    expect(countByChannel("123456789012345678")).toBe(0);
    expect(countByChannel("987654321098765432")).toBe(1);
  });
});
