import type { NormalizedEvent } from "./backend.js";
import { L } from "../utils/i18n.js";

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function formatQuestionCard(card: unknown): string | null {
  const c = object(card);
  if (typeof c.prompt !== "string" || !c.prompt.trim()) return null;
  if (c.options !== undefined && !Array.isArray(c.options)) return null;
  const lines = [`📝 ${c.prompt}`];
  const name = object(c.objective).name;
  if (typeof name === "string" && name.trim()) lines.push(`🎯 ${name}`);
  for (const option of c.options ?? []) {
    const o = object(option);
    if (typeof o.label !== "string" || typeof o.body !== "string") return null;
    lines.push(`${o.label}. ${o.body}`);
  }
  lines.push(L("↩️ Reply with your answer in this channel", "↩️ 이 채널에 답을 입력하세요"));
  return lines.join("\n");
}

const pct = (value: unknown) => typeof value === "number" ? `${Math.round(value * 100)}%` : null;

/** DeepTutor shows the verdict on its own web answer card and tells the model not to restate it, so render it here. */
export function formatGradeCard(grade: unknown): string | null {
  const g = object(grade);
  if (typeof g.is_correct !== "boolean") return null;
  const r = object(g.result);
  const answer = typeof r.correct_label === "string" && typeof r.correct_body === "string" ? `${r.correct_label}. ${r.correct_body}` : null;
  const lines = [g.is_correct
    ? L("✅ Correct", "✅ 정답")
    : `${L("❌ Incorrect", "❌ 오답")}${answer ? ` — ${L("answer", "정답")}: ${answer}` : ""}`];
  const note = [r.feedback, r.explanation].find(v => typeof v === "string" && v.trim()) as string | undefined;
  if (note) lines.push(note);
  const mastery = pct(g.mastery);
  if (mastery) lines.push(`${L("Mastery", "숙련도")} ${mastery}${pct(g.threshold) ? ` → ${L("goal", "목표")} ${pct(g.threshold)}` : ""}`);
  if (g.mastered === true) lines.push(L("🎉 Objective mastered", "🎉 목표 달성"));
  return lines.join("\n");
}

export function translateDeepTutorEvent(ev: unknown): NormalizedEvent[] {
  const e = object(ev);
  const metadata = object(e.metadata);
  const content = typeof e.content === "string" ? e.content : "";
  const events: NormalizedEvent[] = [];
  switch (e.type) {
    case "content":
      if (content) events.push({ type: "text_delta", text: content });
      break;
    case "session": {
      const id = metadata.session_id || e.session_id;
      if (typeof id === "string" && id) events.push({ type: "session_init", sessionId: id });
      break;
    }
    case "tool_call":
      events.push({ type: "tool_start", toolName: content || "tool", input: object(metadata.args) });
      break;
    case "tool_result":
      events.push({ type: "tool_end", toolName: typeof metadata.tool === "string" && metadata.tool || "tool", ok: metadata.success !== false });
      break;
    case "error":
      events.push({ type: "result", text: content || L("DeepTutor error", "DeepTutor 오류"), isError: true });
      break;
    case "done":
      events.push({ type: "result", text: content, isError: false });
      break;
  }
  if (e.type === "tool_result") {
    const grade = formatGradeCard(object(metadata.tool_metadata).mastery_grade);
    if (grade) events.push({ type: "text_delta", text: grade });
  }
  if (e.type === "content" || e.type === "tool_result") {
    const text = formatQuestionCard(object(metadata.tool_metadata).mastery_question);
    if (text) events.push({ type: "text_delta", text });
  }
  return events;
}
