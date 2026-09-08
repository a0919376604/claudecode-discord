import type { AgentBackend } from "./backend.js";
import { ClaudeBackend } from "./claude-backend.js";

/**
 * Returns the AgentBackend for a channel. Reads `project.backend` from DB.
 * Callers must have verified the project is registered.
 *
 * For now, always returns ClaudeBackend. M3 wires in CodexBackend based on
 * the `backend` column added by Task 11.
 */
export function getBackend(_channelId: string): AgentBackend {
  return new ClaudeBackend();
}
