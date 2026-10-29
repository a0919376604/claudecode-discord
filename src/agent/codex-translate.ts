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
  commandExecution: "Bash",
  fileChange: "Write",
  mcpToolCall: "MCP",
  webSearch: "WebSearch",
  imageGeneration: "ImageGeneration",
  dynamicToolCall: "Tool",
  collabAgentToolCall: "Agent",
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

  if (method === "turn/plan/updated") {
    if (!Array.isArray(p?.plan) || !p.plan.every(s => s && typeof s.step === "string" && ["pending", "inProgress", "completed"].includes(s.status))) return null;
    return { type: "plan_update", steps: p.plan };
  }

  if (method === "model/rerouted" && typeof p?.threadId === "string" && typeof p.toModel === "string") {
    return { type: "session_init", sessionId: p.threadId, model: p.toModel };
  }

  if (method === "item/agentMessage/delta") {
    const delta = p && typeof p.delta === "string" ? p.delta : null;
    if (delta === null) return null;
    return { type: "text_delta", text: delta };
  }

  if (method === "item/reasoning/textDelta" || method === "item/reasoning/summaryTextDelta") {
    const delta = p && typeof p.delta === "string" ? p.delta : null;
    if (delta === null) return null;
    return { type: "text_delta", text: delta, isReasoning: true };
  }

  if (method === "item/started" || method === "item/completed") {
    const item = p && (p.item as Record<string, unknown> | undefined);
    if (!item || typeof item.type !== "string") return null;
    // Only emit tool_start for known tool types. Non-tool items
    // (userMessage, agentMessage, reasoning, etc.) also fire item/started
    // but are surfaced via their own delta/stream notifications.
    const toolName = CODEX_TOOL_TYPE_MAP[item.type];
    if (!toolName) return null;
    // Strip `type` and pass the rest as input
    const { type: _t, ...input } = item;
    if (method === "item/completed") {
      const ok = item.status !== "failed" && item.status !== "declined" &&
        item.success !== false && !item.error &&
        !(typeof item.exitCode === "number" && item.exitCode !== 0);
      return { type: "tool_end", toolName, ok, input };
    }
    return { type: "tool_start", toolName, input };
  }

  if (method === "turn/completed") {
    if (!p) return null;
    const turn = p.turn as { status?: string; error?: { message?: string } } | undefined;
    if (turn?.error || p.error || turn?.status === "failed" || turn?.status === "interrupted") {
      const err = (turn?.error ?? p.error) as { message?: string } | undefined;
      return { type: "result", text: err?.message ?? (turn?.status === "interrupted" ? "Task interrupted" : "Task failed"), isError: true };
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
