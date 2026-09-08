import type { NormalizedEvent } from "./backend.js";

/**
 * Codex tool types → Discord-friendly tool names. Keep in sync with
 * SessionManager's toolLabels lookup so heartbeat activity strings render
 * consistently across backends.
 */
const CODEX_TOOL_TYPE_MAP: Record<string, string> = {
  shell_command: "Bash",
  apply_patch: "Write",
  mcp_tool_call: "MCP",
};

export function notificationToEvent(notif: { method: string; params: unknown }): NormalizedEvent | null {
  const { method, params } = notif;
  const p = params as Record<string, unknown> | null | undefined;

  if (method === "item/agentMessage/delta") {
    const delta = p && typeof p.delta === "string" ? p.delta : null;
    if (delta === null) return null;
    return { type: "text_delta", text: delta };
  }

  if (method === "item/reasoning/textDelta") {
    const delta = p && typeof p.delta === "string" ? p.delta : null;
    if (delta === null) return null;
    return { type: "text_delta", text: delta, isReasoning: true };
  }

  if (method === "item/started") {
    const item = p && (p.item as Record<string, unknown> | undefined);
    if (!item || typeof item.type !== "string") return null;
    const toolName = CODEX_TOOL_TYPE_MAP[item.type] ?? item.type;
    // Strip `type` and pass the rest as input
    const { type: _t, ...input } = item;
    return { type: "tool_start", toolName, input };
  }

  if (method === "turn/completed") {
    if (!p) return null;
    if (p.error) {
      const err = p.error as { message?: string };
      return { type: "result", text: err.message ?? "Task failed", isError: true };
    }
    const finalMessage = typeof p.finalMessage === "string" ? p.finalMessage : "Task completed";
    return { type: "result", text: finalMessage, isError: false };
  }

  return null;
}
