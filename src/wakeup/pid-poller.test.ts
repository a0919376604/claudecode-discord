import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pollOnce } from "./pid-poller.js";
import type { RunPlanSlotRow } from "../db/types.js";
import type { WakeupPayload } from "./types.js";

describe("pid-poller pollOnce", () => {
  let tmp: string;
  let enqueued: WakeupPayload[];
  let processed: string[];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pid-poller-"));
    enqueued = [];
    processed = [];
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const makeSlot = (slot: string, ageMs: number): RunPlanSlotRow => ({
    slot,
    channel_id: "1505079292487274537",
    launched_at: Date.now() - ageMs,
  });

  it("skips a slot younger than the grace period (60s)", () => {
    // Slot 30s old with a dead PID — must NOT fire yet. Grace period
    // prevents racing the codex startup.
    fs.writeFileSync(path.join(tmp, "run-plan-codex-fresh.pid"), "999999999");
    pollOnce({
      tmpDir: tmp,
      listSlots: () => [makeSlot("fresh", 30_000)],
      onSlotProcessed: (s) => processed.push(s),
      enqueue: (p) => enqueued.push(p),
    });
    expect(enqueued).toHaveLength(0);
    expect(processed).toHaveLength(0);
  });

  it("fires wakeup when PID is dead + no done file + slot older than grace", () => {
    // PID that we know cannot exist (32-bit range max, never reused)
    fs.writeFileSync(path.join(tmp, "run-plan-codex-dead.pid"), "999999999");
    pollOnce({
      tmpDir: tmp,
      listSlots: () => [makeSlot("dead", 120_000)], // 2 min old
      onSlotProcessed: (s) => processed.push(s),
      enqueue: (p) => enqueued.push(p),
    });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].channel_id).toBe("1505079292487274537");
    expect(enqueued[0].source).toBe("run-plan-poller");
    expect(enqueued[0].prompt).toBe("/run-plan status dead");
    expect(enqueued[0].metadata).toMatchObject({
      slot: "dead",
      detected_by: "pid-poller",
    });
    // Single-shot: slot is removed after firing.
    expect(processed).toEqual(["dead"]);
  });

  it("does NOT fire when the codex process is still alive", () => {
    // Use our own PID — guaranteed alive during test run.
    fs.writeFileSync(path.join(tmp, "run-plan-codex-alive.pid"), String(process.pid));
    pollOnce({
      tmpDir: tmp,
      listSlots: () => [makeSlot("alive", 120_000)],
      onSlotProcessed: (s) => processed.push(s),
      enqueue: (p) => enqueued.push(p),
    });
    expect(enqueued).toHaveLength(0);
    expect(processed).toHaveLength(0); // slot stays tracked
  });

  it("does NOT fire (and cleans up) when a done file already exists", () => {
    // Skill's normal path handled it. We drop our tracking.
    fs.writeFileSync(path.join(tmp, "run-plan-codex-normal.pid"), "999999999");
    fs.writeFileSync(path.join(tmp, "run-plan-done-normal.txt"), "slot=normal\nstatus=DONE\n");
    pollOnce({
      tmpDir: tmp,
      listSlots: () => [makeSlot("normal", 120_000)],
      onSlotProcessed: (s) => processed.push(s),
      enqueue: (p) => enqueued.push(p),
    });
    expect(enqueued).toHaveLength(0);
    expect(processed).toEqual(["normal"]);
  });

  it("cleans up stale slot when PID file no longer exists", () => {
    // No .pid file — codex was never launched or files got cleaned.
    pollOnce({
      tmpDir: tmp,
      listSlots: () => [makeSlot("stale", 120_000)],
      onSlotProcessed: (s) => processed.push(s),
      enqueue: (p) => enqueued.push(p),
    });
    expect(enqueued).toHaveLength(0);
    expect(processed).toEqual(["stale"]);
  });

  it("cleans up stale slot when PID file is corrupt", () => {
    fs.writeFileSync(path.join(tmp, "run-plan-codex-corrupt.pid"), "not-a-number");
    pollOnce({
      tmpDir: tmp,
      listSlots: () => [makeSlot("corrupt", 120_000)],
      onSlotProcessed: (s) => processed.push(s),
      enqueue: (p) => enqueued.push(p),
    });
    expect(enqueued).toHaveLength(0);
    expect(processed).toEqual(["corrupt"]);
  });

  it("handles multiple slots in one poll pass without cross-contamination", () => {
    fs.writeFileSync(path.join(tmp, "run-plan-codex-a.pid"), "999999999");
    fs.writeFileSync(path.join(tmp, "run-plan-codex-b.pid"), String(process.pid)); // alive
    fs.writeFileSync(path.join(tmp, "run-plan-codex-c.pid"), "888888888");
    fs.writeFileSync(path.join(tmp, "run-plan-done-c.txt"), "status=DONE\n"); // handled by skill

    pollOnce({
      tmpDir: tmp,
      listSlots: () => [
        makeSlot("a", 120_000),
        makeSlot("b", 120_000),
        makeSlot("c", 120_000),
      ],
      onSlotProcessed: (s) => processed.push(s),
      enqueue: (p) => enqueued.push(p),
    });

    // a: dead → wakeup + removed
    // b: alive → keep, no wakeup
    // c: done file exists → skill owns it, remove tracking, no wakeup
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].metadata).toMatchObject({ slot: "a" });
    expect(processed.sort()).toEqual(["a", "c"]);
  });

  it("does not crash when listSlots throws", () => {
    // e.g. DB in a broken state during a restart. The poller must not
    // propagate the error to the caller (which would eventually crash
    // the interval timer).
    expect(() =>
      pollOnce({
        tmpDir: tmp,
        listSlots: () => {
          throw new Error("DB corrupt");
        },
      }),
    ).not.toThrow();
  });

  it("isolates errors per-slot — one bad slot doesn't block others", () => {
    fs.writeFileSync(path.join(tmp, "run-plan-codex-ok.pid"), "999999999");
    // "bad" slot has no PID file → handleSlot() falls through cleanly
    // (already tested). Simulate a truly-broken slot by making pidFile a
    // directory instead of a file — readFileSync throws.
    fs.mkdirSync(path.join(tmp, "run-plan-codex-broken.pid"));

    pollOnce({
      tmpDir: tmp,
      listSlots: () => [makeSlot("broken", 120_000), makeSlot("ok", 120_000)],
      onSlotProcessed: (s) => processed.push(s),
      enqueue: (p) => enqueued.push(p),
    });

    // "ok" must still fire despite the earlier broken slot throwing.
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].metadata).toMatchObject({ slot: "ok" });
  });
});
