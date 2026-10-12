import type { NormalizedEvent } from "./backend.js";

/**
 * Pure translator: one SDK message → zero or one NormalizedEvent.
 *
 * For `assistant` messages with multiple content blocks, this returns
 * only the FIRST text block; callers must iterate `content[]` themselves
 * and call this per-block (or use `assistantContentToEvents` below).
 *
 * Returns null for messages we don't care about (unknown types, system
 * init without session_id, non-text blocks).
 */
export function sdkMessageToEvent(msg: unknown): NormalizedEvent | null {
  if (!msg || typeof msg !== "object" || !("type" in msg)) return null;
  const m = msg as { type: string; [k: string]: unknown };

  if (m.type === "system" && (m as { subtype?: string }).subtype === "init") {
    const sessionId = (m as { session_id?: string }).session_id;
    if (!sessionId) return null;
    const model = (m as { model?: string }).model;
    return model ? { type: "session_init", sessionId, model } : { type: "session_init", sessionId };
  }

  if (m.type === "assistant") {
    const content = assistantContent(m);
    if (!Array.isArray(content) || content.length === 0) return null;
    const first = content[0];
    if (first && typeof first === "object" && "text" in first && typeof (first as { text: unknown }).text === "string") {
      return { type: "text_delta", text: (first as { text: string }).text };
    }
    return null;
  }

  if (m.type === "result") {
    const r = m as {
      subtype?: string;
      result?: string;
      errors?: string[];
      is_error?: boolean;
      total_cost_usd?: number;
    };
    const isError =
      r.is_error === true || (r.subtype !== undefined && r.subtype !== "success");
    // Fallbacks must handle BOTH nullish AND empty string. SDK returns
    // `result: ""` when a wakeup / silent-tool turn produces no visible
    // output. `??` alone would leave text as "", causing
    // createResultEmbed → EmbedBuilder.setDescription("") → shapeshift
    // "Invalid string length" crash (see docs/… — surfaced Sep 2026).
    let text: string;
    if (isError) {
      const joined = (r.errors ?? []).filter((e) => e && e.length > 0).join("; ");
      text = joined.length > 0 ? joined : "Task failed";
    } else {
      text = r.result && r.result.length > 0 ? r.result : "Task completed";
    }
    return { type: "result", text, costUsd: r.total_cost_usd, isError };
  }

  return null;
}

/**
 * Yields one text_delta per text block and one tool_start per tool_use block
 * in an assistant message. tool_use blocks are the only tool signal that
 * fires in bypassPermissions mode (canUseTool is never called there), so the
 * progress line can show which tool is running.
 */
export function assistantContentToEvents(msg: unknown): NormalizedEvent[] {
  if (!msg || typeof msg !== "object" || (msg as { type?: string }).type !== "assistant") return [];
  const content = assistantContent(msg);
  if (!Array.isArray(content)) return [];
  const out: NormalizedEvent[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; text?: unknown; name?: unknown; input?: unknown };
    if (typeof b.text === "string") {
      out.push({ type: "text_delta", text: b.text });
    } else if (b.type === "tool_use" && typeof b.name === "string") {
      const input = b.input && typeof b.input === "object" ? (b.input as Record<string, unknown>) : {};
      out.push({ type: "tool_start", toolName: b.name, input });
    }
  }
  return out;
}

// Real SDKAssistantMessage nests blocks under `message.content` (BetaMessage).
// Reading top-level `content` only matched hand-written test fixtures, so no
// text_delta ever fired and replies only showed up inside the result embed.
function assistantContent(msg: object): unknown {
  return (msg as { message?: { content?: unknown } }).message?.content
    ?? (msg as { content?: unknown }).content;
}
