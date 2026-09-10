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
    return { type: "session_init", sessionId };
  }

  if (m.type === "assistant") {
    const content = (m as { content?: unknown }).content;
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
 * Convenience: yields one text_delta per text block in an assistant
 * message. Non-text blocks are skipped silently.
 */
export function assistantContentToEvents(msg: unknown): NormalizedEvent[] {
  if (!msg || typeof msg !== "object" || (msg as { type?: string }).type !== "assistant") return [];
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  const out: NormalizedEvent[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && "text" in block && typeof (block as { text: unknown }).text === "string") {
      out.push({ type: "text_delta", text: (block as { text: string }).text });
    }
  }
  return out;
}
