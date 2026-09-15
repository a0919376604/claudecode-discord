import type { HookDeps, HookResult } from "./schedule-wakeup.js";
import { upsertRunPlanSlot } from "../db/database.js";

/**
 * Match anything that looks like a run-plan codex launch.
 *
 * The skill's Step 3 convention writes the log to `/tmp/run-plan-codex-<slot>.log`
 * regardless of whether the launch uses `nohup codex exec`, `codex exec ... 2>&1`,
 * or Claude's ad-hoc retry patterns. Every observed manual-retry variant in the
 * wild has still redirected to `/tmp/run-plan-codex-<slot>.log(.runN)?` — that
 * path is our stable landmark.
 *
 * Groups: [1] = slot (without any `.runN` suffix).
 *
 * Examples matched:
 *   nohup codex exec ... > /tmp/run-plan-codex-R-184.log 2>&1 &
 *   codex exec - < /tmp/run-plan-prompt-X.txt > /tmp/run-plan-codex-X.log 2>&1
 *   ... > "/tmp/run-plan-codex-my-slot.log.run4" 2>&1 &
 *   ... > '/tmp/run-plan-codex-my-slot.log.run4' 2>&1 &
 */
const CODEX_LAUNCH_LOG_RE =
  /["']?\/tmp\/run-plan-codex-([^"'\s.]+(?:\.[^"'\s.]+)*?)\.log(?:\.run\d+)?["']?/;

/** Extract the slot from a Bash command that appears to launch codex. */
export function extractCodexSlot(command: string): string | null {
  // Guard: only bother matching if the command actually mentions codex.
  // This keeps the hot path cheap for the many Bash calls that have
  // nothing to do with codex.
  if (!command.includes("codex") && !command.includes("run-plan-codex-")) return null;

  const m = command.match(CODEX_LAUNCH_LOG_RE);
  if (!m) return null;
  return m[1];
}

interface BashInput {
  command?: unknown;
  [k: string]: unknown;
}

function isBashInput(x: unknown): x is BashInput {
  return typeof x === "object" && x !== null;
}

/**
 * PreToolUse handler for the Bash tool. NEVER denies (returns
 * `{continue: true}` unconditionally) — this is purely a side-effect
 * observer that records `slot → channel_id` mappings in the DB.
 *
 * Called from pre-tool-use.ts's switch. Errors are swallowed at the
 * pre-tool-use.ts level (its own catch wraps the whole switch), so a
 * malformed input or DB write hiccup can never block a real Bash tool.
 */
export function handleBashLaunch(input: unknown, deps: HookDeps): HookResult {
  if (!isBashInput(input) || typeof input.command !== "string") {
    return { continue: true };
  }
  const slot = extractCodexSlot(input.command);
  if (!slot) return { continue: true };

  upsertRunPlanSlot(slot, deps.channelId, deps.now());
  return { continue: true };
}
