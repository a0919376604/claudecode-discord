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

/**
 * Translate a codex JSON-RPC notification to a NormalizedEvent.
 *
 * @param notif - The raw notification from the codex app-server.
 * @param accumulatedText - For turn/completed: the aggregated assistant text
 *   collected by the caller from item/agentMessage/delta events.  The codex
 *   protocol does not carry a finalMessage field, so the caller must supply
 *   the accumulated text here.
 */
export function notificationToEvent(
  notif: { method: string; params: unknown },
  accumulatedText?: string,
): NormalizedEvent | null {
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
    // Only emit tool_start for known tool types. Non-tool items
    // (userMessage, agentMessage, reasoning, etc.) also fire item/started
    // but are surfaced via their own delta/stream notifications.
    const toolName = CODEX_TOOL_TYPE_MAP[item.type];
    if (!toolName) return null;
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
    // codex does not send a finalMessage field; use accumulated assistant
    // text passed in by the caller (CodexBackend aggregates agentMessage/delta
    // chunks). Fall back to empty string — SessionManager shows the streamed
    // content already and will omit the result embed description if empty.
    const resultText = accumulatedText ?? "";
    return { type: "result", text: resultText, isError: false };
  }

  return null;
}
