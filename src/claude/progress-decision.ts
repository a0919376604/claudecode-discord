/**
 * Progress-update decision logic, factored out from session-manager so it can
 * be unit-tested without spinning up the full Discord/SDK stack.
 *
 * The session-manager streams Claude output to Discord in two phases:
 *   1. Before Claude emits any text — we edit the original "Thinking..."
 *      message in place with a heartbeat + tool-use status.
 *   2. After Claude has streamed text — the original message now holds real
 *      content, so we MUST NOT clobber it. Instead, if Claude goes silent
 *      doing tool work for more than `staleThresholdMs`, we send (or update)
 *      a SEPARATE progress message below the streamed text.
 *
 * Prior to this fix, both heartbeat and tool-status updates were gated on
 * `!hasTextOutput`, which meant a multi-hour tool-heavy session after an
 * initial text response left the Discord UI frozen — even though Claude was
 * still working and burning tokens.
 */

export type ProgressAction =
  | "edit-current" // pre-text phase: edit the initial Thinking message
  | "edit-progress" // post-text phase, reusing existing progress message
  | "send-progress" // post-text phase, no progress message yet
  | "skip"; // post-text phase but text is recent — let the streaming edits show

export interface ProgressDecisionState {
  hasTextOutput: boolean;
  lastTextTime: number;
  now: number;
  staleThresholdMs: number;
  progressMessageExists: boolean;
}

/**
 * Decide what kind of Discord write to perform for a progress tick.
 *
 * Pure function — no I/O, no clocks. Pass `now` explicitly so tests can run
 * deterministically against fake timers.
 */
export function decideProgressAction(state: ProgressDecisionState): ProgressAction {
  // Pre-text phase: original Thinking message is still safe to clobber.
  if (!state.hasTextOutput) return "edit-current";

  // Post-text phase: streaming edits are happening recently — don't pile on.
  const sinceText = state.now - state.lastTextTime;
  if (sinceText < state.staleThresholdMs) return "skip";

  return state.progressMessageExists ? "edit-progress" : "send-progress";
}

/**
 * Format the elapsed-time portion shown to users, e.g. "5s", "1m 30s", "2h 5m".
 * Caps at hours since a session lasting days isn't a real use case here.
 */
export function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (totalMin < 60) return `${totalMin}m ${secs}s`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  return `${hours}h ${mins}m`;
}

/**
 * Build the user-facing progress line. Tool count is only shown when at
 * least one tool has run, so the initial "Thinking..." state stays clean.
 */
export function buildProgressContent(
  activity: string,
  elapsedMs: number,
  toolUseCount: number,
): string {
  const timeStr = formatElapsed(elapsedMs);
  const toolStr = toolUseCount > 0 ? ` [${toolUseCount} tools used]` : "";
  return `⏳ ${activity} (${timeStr})${toolStr}`;
}
