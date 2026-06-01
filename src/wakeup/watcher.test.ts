import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WakeupWatcher } from "./watcher.js";
import type { WakeupPayload } from "./types.js";
import Database from "better-sqlite3";
import { setQueueDb, countByChannel } from "./queue.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const validPayload: WakeupPayload = {
  channel_id: "123456789012345678",
  prompt: "/run-plan status foo",
  source: "run-plan",
  metadata: { slot: "foo", status: "DONE", commits: "+3" },
  created_at: new Date().toISOString(),
  ttl_seconds: 86400,
};

function freshDb() {
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
  `);
  return db;
}

describe("WakeupWatcher.handleEvent", () => {
  let wakeUp: ReturnType<typeof vi.fn>;
  let hasActiveSession: ReturnType<typeof vi.fn>;
  let sendPassiveEmbed: ReturnType<typeof vi.fn>;
  let isChannelRegistered: ReturnType<typeof vi.fn>;
  let watcher: WakeupWatcher;

  beforeEach(() => {
    setQueueDb(freshDb());
    wakeUp = vi.fn().mockResolvedValue(undefined);
    hasActiveSession = vi.fn().mockReturnValue(false);
    sendPassiveEmbed = vi.fn().mockResolvedValue(undefined);
    isChannelRegistered = vi.fn().mockReturnValue(true);
    watcher = new WakeupWatcher({
      wakeupDir: "/dev/null",
      legacyDir: "/dev/null",
      isChannelRegistered,
      hasActiveSession,
      wakeUp,
      sendPassiveEmbed,
    });
  });

  it("calls wakeUp directly when no active session", async () => {
    await watcher.handleEvent(validPayload);
    expect(sendPassiveEmbed).toHaveBeenCalledOnce();
    expect(wakeUp).toHaveBeenCalledWith(
      validPayload.channel_id,
      validPayload.prompt,
      "run-plan",
    );
    expect(countByChannel(validPayload.channel_id)).toBe(0);
  });

  it("queues wakeup when active session exists", async () => {
    hasActiveSession.mockReturnValue(true);
    await watcher.handleEvent(validPayload);
    expect(sendPassiveEmbed).toHaveBeenCalledOnce();
    expect(wakeUp).not.toHaveBeenCalled();
    expect(countByChannel(validPayload.channel_id)).toBe(1);
  });

  it("drops events for unregistered channels (no embed, no wakeup)", async () => {
    isChannelRegistered.mockReturnValue(false);
    await watcher.handleEvent(validPayload);
    expect(sendPassiveEmbed).not.toHaveBeenCalled();
    expect(wakeUp).not.toHaveBeenCalled();
    expect(countByChannel(validPayload.channel_id)).toBe(0);
  });

  it("drops expired events", async () => {
    const expired = {
      ...validPayload,
      created_at: new Date(Date.now() - 200_000).toISOString(),
      ttl_seconds: 60,
    };
    await watcher.handleEvent(expired);
    expect(sendPassiveEmbed).not.toHaveBeenCalled();
    expect(wakeUp).not.toHaveBeenCalled();
  });

  it("dedupes when same slot queued twice during active session", async () => {
    hasActiveSession.mockReturnValue(true);
    await watcher.handleEvent(validPayload);
    await watcher.handleEvent({ ...validPayload, prompt: "/run-plan status foo updated" });
    expect(countByChannel(validPayload.channel_id)).toBe(1);
  });
});

describe("WakeupWatcher filesystem integration", () => {
  let wakeupDir: string;
  let legacyDir: string;
  let watcher: WakeupWatcher;
  let wakeUp: ReturnType<typeof vi.fn>;
  let sendPassiveEmbed: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    setQueueDb(freshDb());
    wakeupDir = fs.mkdtempSync(path.join(os.tmpdir(), "wakeup-dir-"));
    legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "wakeup-legacy-"));
    wakeUp = vi.fn().mockResolvedValue(undefined);
    sendPassiveEmbed = vi.fn().mockResolvedValue(undefined);
    watcher = new WakeupWatcher({
      wakeupDir,
      legacyDir,
      isChannelRegistered: () => true,
      hasActiveSession: () => false,
      wakeUp,
      sendPassiveEmbed,
    });
    await watcher.start();
  });

  afterEach(async () => {
    await watcher.stop();
    fs.rmSync(wakeupDir, { recursive: true, force: true });
    fs.rmSync(legacyDir, { recursive: true, force: true });
  });

  it("startup scan picks up files dropped before start()", async () => {
    await watcher.stop();
    const payload = {
      channel_id: "123456789012345678",
      prompt: "/x",
      source: "test",
      created_at: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(wakeupDir, "pre-existing.json"), JSON.stringify(payload));
    await watcher.start();
    // Drain microtasks
    await new Promise((r) => setTimeout(r, 50));
    expect(wakeUp).toHaveBeenCalledWith("123456789012345678", "/x", "test");
    // File got cleaned up
    expect(fs.existsSync(path.join(wakeupDir, "pre-existing.json"))).toBe(false);
  });

  it("moves malformed JSON to .rejected/ subdir", async () => {
    await watcher.stop();
    fs.writeFileSync(path.join(wakeupDir, "bad.json"), "{ not json");
    await watcher.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(wakeUp).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(wakeupDir, ".rejected", "bad.json"))).toBe(true);
  });

  it("ignores files lacking .json extension", async () => {
    await watcher.stop();
    fs.writeFileSync(path.join(wakeupDir, "temp.tmp"), "ignored");
    await watcher.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(wakeUp).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(wakeupDir, "temp.tmp"))).toBe(true);
  });

  it("synthesizes payload from legacy /tmp/run-plan-done file", async () => {
    await watcher.stop();
    fs.writeFileSync(
      path.join(legacyDir, "run-plan-done-foo.txt"),
      "slot=foo\nstatus=DONE\ncommits=+2\n",
    );
    fs.writeFileSync(
      path.join(legacyDir, "run-plan-meta-foo.txt"),
      "plan=/p\nbranch=main\nchannel_id=123456789012345678\n",
    );
    await watcher.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(wakeUp).toHaveBeenCalledWith(
      "123456789012345678",
      "/run-plan status foo",
      "run-plan",
    );
    // Legacy done file is NOT deleted (skill owns that state)
    expect(fs.existsSync(path.join(legacyDir, "run-plan-done-foo.txt"))).toBe(true);
  });
});
