import { getProject } from "../db/database.js";
import type { AgentBackend } from "./backend.js";
import { ClaudeBackend } from "./claude-backend.js";
import { CodexBackend } from "./codex-backend.js";

/**
 * Returns the AgentBackend for a channel. Reads `project.backend` from DB.
 * Callers must have verified the project is registered.
 */
export function getBackend(channelId: string): AgentBackend {
  const project = getProject(channelId);
  if (project?.backend === "codex") return new CodexBackend();
  return new ClaudeBackend();
}
