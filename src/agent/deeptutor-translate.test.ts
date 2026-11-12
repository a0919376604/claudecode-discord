import { describe, expect, it, vi } from "vitest";
vi.mock("../utils/i18n.js", () => ({ L: (en: string) => en }));
import { formatQuestionCard, translateDeepTutorEvent } from "./deeptutor-translate.js";

const card = {
  prompt: "Pick the synonym of big", objective: { id: "k1", name: "Vocab" },
  options: [{ label: "A", body: "large" }, { label: "B", body: "tiny" }],
  get expected_answer(): never { throw new Error("must not read expected_answer"); },
  get explanation(): never { throw new Error("must not read explanation"); },
};
const cardText = "📝 Pick the synonym of big\n🎯 Vocab\nA. large\nB. tiny\n↩️ Reply with your answer in this channel";

describe("translateDeepTutorEvent", () => {
  it("content → text_delta", () => {
    expect(translateDeepTutorEvent({ type: "content", content: "hi" })).toEqual([{ type: "text_delta", text: "hi" }]);
  });
  it("session → session_init from metadata", () => {
    expect(translateDeepTutorEvent({ type: "session", metadata: { session_id: "s1" } })).toEqual([{ type: "session_init", sessionId: "s1" }]);
  });
  it("tool_result with card emits tool_end then card text without reading answers", () => {
    expect(translateDeepTutorEvent({ type: "tool_result", metadata: { tool: "mastery_quiz", tool_metadata: { mastery_question: card } } }))
      .toEqual([{ type: "tool_end", toolName: "mastery_quiz", ok: true }, { type: "text_delta", text: cardText }]);
  });
  it("tool_call → tool_start", () => {
    expect(translateDeepTutorEvent({ type: "tool_call", content: "mastery_status", metadata: { args: { a: 1 } } }))
      .toEqual([{ type: "tool_start", toolName: "mastery_status", input: { a: 1 } }]);
  });
  it("content with card metadata emits text then card text", () => {
    expect(translateDeepTutorEvent({ type: "content", content: "Try this", metadata: { tool_metadata: { mastery_question: card } } }))
      .toEqual([{ type: "text_delta", text: "Try this" }, { type: "text_delta", text: cardText }]);
  });
  it.each([
    [{ type: "error", content: "bad" }, [{ type: "result", text: "bad", isError: true }]],
    [{ type: "result", content: "" }, []],
    [{ type: "result", content: "not finished" }, []],
    [{ type: "done" }, [{ type: "result", text: "", isError: false }]],
    [{ type: "done", content: "finished" }, [{ type: "result", text: "finished", isError: false }]],
    [{ type: "unknown" }, []], [null, []],
    [{ type: "content", content: "" }, []],
    [{ type: "session", session_id: "s2" }, [{ type: "session_init", sessionId: "s2" }]],
    [{ type: "session" }, []],
  ])("maps %j", (input, expected) => {
    expect(translateDeepTutorEvent(input)).toEqual(expected);
  });
});

describe("formatQuestionCard", () => {
  it("card footer uses the English slot", () => {
    expect(formatQuestionCard({ prompt: "Pick" })?.split("\n").at(-1)).toBe("↩️ Reply with your answer in this channel");
  });
  it("formats only public question fields", () => { expect(formatQuestionCard(card)).toBe(cardText); });
  it.each([null, {}, { prompt: 12 }, { prompt: "" }, { prompt: "ok", options: [{ label: "A" }] }])("rejects invalid card %j", (input) => {
    expect(formatQuestionCard(input)).toBeNull();
  });
  it("renders a wrong-answer grade card with the correct option, feedback and mastery", () => {
    const events = translateDeepTutorEvent({ type: "tool_result", metadata: { tool: "mastery_grade", tool_metadata: { mastery_grade: {
      is_correct: false, mastery: 0.643, threshold: 0.9, mastered: false,
      result: { correct_label: "A", correct_body: "me", feedback: "め has no loop.", explanation: "め has no loop." },
    } } } });
    const text = events.filter(e => e.type === "text_delta").map(e => e.text).join("");
    for (const part of ["❌", "A. me", "め has no loop.", "64%", "90%"]) expect(text).toContain(part);
    expect(text.match(/め has no loop\./g)).toHaveLength(1);
  });
  it("renders a correct grade card and flags a mastered objective", () => {
    const events = translateDeepTutorEvent({ type: "tool_result", metadata: { tool: "mastery_grade", tool_metadata: { mastery_grade: {
      is_correct: true, mastery: 0.92, threshold: 0.9, mastered: true, result: { explanation: "ね has a loop." },
    } } } });
    const text = events.filter(e => e.type === "text_delta").map(e => e.text).join("");
    for (const part of ["✅", "ね has a loop.", "92%", "🎉"]) expect(text).toContain(part);
  });
});
