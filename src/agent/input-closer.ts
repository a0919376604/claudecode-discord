/**
 * Decides when to end the SDK's streaming-input prompt, i.e. when the run is
 * really over.
 *
 * Why streaming input at all: with a string prompt the SDK closes the
 * control channel after the first result. Any later turn — a background
 * task's notification turn, or the resumed prompt after a stale
 * notification — then has its PreToolUse hook / canUseTool requests
 * cancelled, and the tool comes back as "The user doesn't want to take this
 * action right now. STOP…" (toolDenialKind "cancelled"). Claude obeys that
 * as if the user said stop. Reproduced against SDK 0.3.293, 2026-10-14.
 *
 * When to close: `session_state_changed: idle` fires after EVERY turn, even
 * while background tasks run, so idle alone is not enough. Close once the
 * CLI is idle with no live (non-ambient) background task and stays that way
 * for `graceMs` — a queued prompt flips it back to `running` within
 * milliseconds. CLIs that emit no state events fall back to `result`.
 */
export class InputCloser {
  private idle = false;
  private liveTasks = 0;
  private sawState = false;
  private closed = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly graceMs: number, private readonly onClose: () => void) {}

  state(s: string): void {
    this.sawState = true;
    this.idle = s === "idle";
    this.rearm();
  }

  live(n: number): void {
    this.liveTasks = n;
    this.rearm();
  }

  /** Fallback signal for CLIs that never emit session_state_changed. */
  result(): void {
    if (this.sawState) return;
    this.idle = true;
    this.rearm();
  }

  closeNow(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.onClose();
  }

  private rearm(): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.idle && this.liveTasks === 0) {
      this.timer = setTimeout(() => this.closeNow(), this.graceMs);
    }
  }
}
