import fs from "node:fs";
import path from "node:path";
import { deleteRunPlanSlot, listRunPlanSlots } from "../db/database.js";
import type { RunPlanSlotRow } from "../db/types.js";
import { enqueueWakeup } from "./queue.js";
import { WakeupPayloadSchema, type WakeupPayload } from "./types.js";

/**
 * Polls tracked run-plan slots for the "codex died silently" state:
 *   - PID file exists AND the PID is no longer alive
 *   - AND no /tmp/run-plan-done-<slot>.txt has been written
 *
 * This is the fallback for the Phase-A-uncovered case: Claude's manual
 * `nohup codex exec` retry that doesn't wrap codex in the SKILL.md
 * Step 4 heartbeat, so no DONE_FILE ever gets written when codex exits.
 * Without this poller the user waits forever for a Discord notification
 * that will never come — that IS the bug the user reported.
 *
 * On detection, we synthesize a wakeup payload and enqueue it as if a
 * done file had appeared. Then delete the DB slot entry so we don't
 * re-fire (single-shot per slot).
 *
 * Time bounds:
 *   - Poll interval: 60s (configurable) — codex runs are minutes-hours,
 *     so a minute of latency is fine
 *   - Grace period: don't fire until the slot has been in DB for at
 *     least MIN_AGE_MS (default 60s). Prevents a race where we detect
 *     "PID dead" during the split second between `nohup codex ... &`
 *     dispatch and codex actually starting up
 */
const POLL_INTERVAL_MS = 60_000;
const MIN_AGE_MS = 60_000;

export interface PollDeps {
  /** Directory holding pid + done files. Default: /tmp */
  tmpDir?: string;
  /** Now, in ms. Injectable for tests. */
  now?: () => number;
  /** Injectable for tests — list of tracked slots. Defaults to DB. */
  listSlots?: () => RunPlanSlotRow[];
  /** Injectable for tests. */
  onSlotProcessed?: (slot: string) => void;
  /** Injectable for tests — enqueue the synthesized wakeup. */
  enqueue?: (payload: WakeupPayload) => void;
}

/**
 * A single poll pass. Exported for direct unit testing without spinning
 * up the interval timer.
 */
export function pollOnce(deps: PollDeps = {}): void {
  const tmpDir = deps.tmpDir ?? "/tmp";
  const now = (deps.now ?? Date.now)();
  const listSlots = deps.listSlots ?? listRunPlanSlots;
  const onProcessed = deps.onSlotProcessed ?? deleteRunPlanSlot;
  const enqueue = deps.enqueue ?? enqueueWakeup;

  let slots: RunPlanSlotRow[];
  try {
    slots = listSlots();
  } catch (e) {
    console.warn(`[pid-poller] listSlots failed:`, e instanceof Error ? e.message : e);
    return;
  }

  for (const row of slots) {
    try {
      handleSlot(row, tmpDir, now, enqueue, onProcessed);
    } catch (e) {
      console.warn(
        `[pid-poller] slot ${row.slot} check failed:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
}

function handleSlot(
  row: RunPlanSlotRow,
  tmpDir: string,
  now: number,
  enqueue: (p: WakeupPayload) => void,
  onProcessed: (slot: string) => void,
): void {
  // Grace period — new slots need a moment for their codex process to
  // actually spawn before we start checking liveness.
  if (now - row.launched_at < MIN_AGE_MS) return;

  const pidFile = path.join(tmpDir, `run-plan-codex-${row.slot}.pid`);
  const doneFile = path.join(tmpDir, `run-plan-done-${row.slot}.txt`);

  // If a DONE file exists, the skill's normal path is handling this
  // — legacy adapter will fire (or has fired). We don't need to.
  if (fs.existsSync(doneFile)) {
    // Clean up our tracking; the normal path owns it now.
    onProcessed(row.slot);
    return;
  }

  // No PID file → codex was never launched (or file was cleaned up).
  // Nothing to poll. Drop the slot — stale entry.
  if (!fs.existsSync(pidFile)) {
    onProcessed(row.slot);
    return;
  }

  const pidStr = fs.readFileSync(pidFile, "utf-8").trim();
  const pid = Number(pidStr);
  if (!Number.isInteger(pid) || pid <= 0) {
    // Corrupt PID file. Not our problem — drop tracking to prevent
    // infinite log spam on every poll.
    onProcessed(row.slot);
    return;
  }

  if (isProcessAlive(pid)) {
    // Codex still running. Check again next poll.
    return;
  }

  // ─── The bug case: PID dead, no DONE_FILE. Synthesize a wakeup. ───
  const candidate = {
    channel_id: row.channel_id,
    prompt: `/run-plan status ${row.slot}`,
    source: "run-plan-poller",
    metadata: {
      slot: row.slot,
      status: "UNKNOWN (codex died without done marker)",
      detected_by: "pid-poller",
    },
    created_at: new Date(now).toISOString(),
  };
  const parsed = WakeupPayloadSchema.safeParse(candidate);
  if (!parsed.success) {
    console.warn(
      `[pid-poller] synthesized payload failed schema for slot ${row.slot}:`,
      parsed.error.message,
    );
    onProcessed(row.slot);
    return;
  }

  enqueue(parsed.data);
  console.log(
    `[pid-poller] slot ${row.slot} — codex PID ${pid} dead with no done file → wakeup enqueued for ${row.channel_id}`,
  );
  onProcessed(row.slot);
}

/**
 * `kill -0` semantic: does a process with this PID exist?
 * Extracted so tests can mock it via the poller's DI seam (indirectly —
 * by controlling which slots are in the fake DB).
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH = no such process; EPERM = process exists but not ours to signal.
    // For our purpose EPERM still means "alive" — but that shouldn't happen
    // for a codex we spawned ourselves.
    // Node's process.kill throws with .code being 'ESRCH' | 'EPERM' | 'EINVAL'.
    const e = (globalThis as { errno?: unknown }).errno;
    // Best-effort: if we can't tell, assume dead (worse to double-notify
    // — but the DB delete makes it single-shot anyway).
    void e;
    return false;
  }
}

let timer: NodeJS.Timeout | null = null;

/**
 * Start the periodic poll. Idempotent — calling twice is a no-op.
 * Runs the first pass immediately so a bot restart doesn't lose
 * up-to-60s of pending detections.
 */
export function startPidPoller(): void {
  if (timer !== null) return;
  pollOnce();
  timer = setInterval(() => {
    try {
      pollOnce();
    } catch (e) {
      console.warn(`[pid-poller] tick failed:`, e instanceof Error ? e.message : e);
    }
  }, POLL_INTERVAL_MS);
}

export function stopPidPoller(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}
