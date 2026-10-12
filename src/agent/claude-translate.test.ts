import { describe, it, expect } from "vitest";
import { sdkMessageToEvent, assistantContentToEvents, translateTaskMessage, type TaskTranslateState } from "./claude-translate.js";

describe("sdkMessageToEvent", () => {
  it("translates system init to session_init", () => {
    const msg = { type: "system", subtype: "init", session_id: "abc-123" };
    expect(sdkMessageToEvent(msg)).toEqual({ type: "session_init", sessionId: "abc-123" });
  });

  it("carries the model from system init", () => {
    const msg = { type: "system", subtype: "init", session_id: "abc-123", model: "claude-opus-5-5" };
    expect(sdkMessageToEvent(msg)).toEqual({ type: "session_init", sessionId: "abc-123", model: "claude-opus-5-5" });
  });

  it("ignores system messages without session_id", () => {
    expect(sdkMessageToEvent({ type: "system", subtype: "init" })).toBeNull();
  });

  it("translates assistant text blocks to text_delta events (one per block)", () => {
    // Translator returns null for multi-block; caller iterates.
    // Instead we test a helper that returns an array:
    // For MVP, translator yields ONE event per call — caller loops content[].
    // So test the single-block case:
    const single = { type: "assistant", content: [{ type: "text", text: "hi" }] };
    expect(sdkMessageToEvent(single)).toEqual({ type: "text_delta", text: "hi" });
  });

  it("reads text from the real SDK shape (message.content)", () => {
    const real = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "hi" },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
          { type: "thinking", thinking: "…" },
          { type: "text", text: "yo" },
        ],
      },
      parent_tool_use_id: null,
      session_id: "s",
    };
    expect(sdkMessageToEvent(real)).toEqual({ type: "text_delta", text: "hi" });
    // tool_use → tool_start: the only tool signal in bypassPermissions mode.
    expect(assistantContentToEvents(real)).toEqual([
      { type: "text_delta", text: "hi" },
      { type: "tool_start", toolName: "Bash", input: { command: "ls" } },
      { type: "text_delta", text: "yo" },
    ]);
  });

  it("translates result success", () => {
    const msg = {
      type: "result",
      subtype: "success",
      result: "done",
      total_cost_usd: 0.05,
      duration_ms: 1000,
    };
    expect(sdkMessageToEvent(msg)).toEqual({
      type: "result",
      text: "done",
      costUsd: 0.05,
      isError: false,
    });
  });

  it("translates result error via subtype", () => {
    const msg = {
      type: "result",
      subtype: "error_during_execution",
      errors: ["boom"],
      is_error: true,
    };
    expect(sdkMessageToEvent(msg)).toEqual({
      type: "result",
      text: "boom",
      costUsd: undefined,
      isError: true,
    });
  });

  it("translates result error via is_error flag", () => {
    const msg = { type: "result", is_error: true, errors: ["oops"] };
    expect(sdkMessageToEvent(msg)).toMatchObject({ isError: true });
  });

  it("falls back to 'Task completed' when result field missing on success", () => {
    const msg = { type: "result", subtype: "success" };
    expect(sdkMessageToEvent(msg)).toMatchObject({ text: "Task completed", isError: false });
  });

  it("falls back to 'Task failed' when errors array empty", () => {
    const msg = { type: "result", is_error: true, errors: [] };
    expect(sdkMessageToEvent(msg)).toMatchObject({ text: "Task failed", isError: true });
  });

  it("returns null for unknown types", () => {
    expect(sdkMessageToEvent({ type: "unknown" })).toBeNull();
  });

  // Regression tests for the "wakeup Task Failed with empty result" bug:
  // SDK sometimes returns success results with `result: ""` (silent wakeup
  // turns that produce no visible output). Old translator's `r.result ??
  // "Task completed"` only fell back on nullish — an empty string slipped
  // through as event.text = "", causing downstream createResultEmbed to
  // crash shapeshift with "Invalid string length" when trying to
  // setDescription("").
  it("falls back to 'Task completed' for success with empty result string", () => {
    const msg = { type: "result", subtype: "success", result: "" };
    expect(sdkMessageToEvent(msg)).toMatchObject({ text: "Task completed", isError: false });
  });

  it("falls back to 'Task failed' for error with only empty-string entries in errors[]", () => {
    const msg = { type: "result", is_error: true, errors: ["", ""] };
    expect(sdkMessageToEvent(msg)).toMatchObject({ text: "Task failed", isError: true });
  });

  it("filters empty strings when joining error messages", () => {
    const msg = { type: "result", is_error: true, errors: ["", "real error", ""] };
    expect(sdkMessageToEvent(msg)).toMatchObject({ text: "real error", isError: true });
  });
});

// Shapes below are copied from a real SDK 0.3.293 run (2026-10-12) with two
// background agents: the agents' own inner Bash calls emitted task_started /
// task_notification but never joined background_tasks_changed.
describe("translateTaskMessage", () => {
  const fresh = (): TaskTranslateState => ({ known: new Set(), errors: new Map() });
  const sys = (subtype: string, rest: Record<string, unknown>) => ({ type: "system", subtype, ...rest });

  it("reports the live set (non-ambient) and remembers those ids", () => {
    const st = fresh();
    const ev = translateTaskMessage(sys("background_tasks_changed", { tasks: [
      { task_id: "a1", task_type: "local_agent", description: "Agent A slow" },
      { task_id: "w1", task_type: "monitor", description: "watcher", ambient: true },
    ] }), st);
    expect(ev).toEqual({ type: "background_tasks", tasks: [{ id: "a1", description: "Agent A slow", taskType: "local_agent" }] });
    expect([...st.known]).toEqual(["a1"]);
  });

  it("ignores task events for ids never seen live (an agent's inner Bash)", () => {
    const st = fresh();
    expect(translateTaskMessage(sys("task_notification", { task_id: "inner", status: "completed", summary: "Pause for 15 seconds" }), st)).toBeNull();
    expect(translateTaskMessage(sys("task_progress", { task_id: "inner", last_tool_name: "Bash", usage: {} }), st)).toBeNull();
  });

  it("maps progress, done (with usage + output file) and attaches task_updated errors", () => {
    const st = fresh();
    st.known.add("a1");
    expect(translateTaskMessage(sys("task_progress", { task_id: "a1", summary: "Listing /tmp entries", last_tool_name: "Bash", usage: { tool_uses: 3 } }), st))
      .toEqual({ type: "task_progress", id: "a1", summary: "Listing /tmp entries", lastTool: "Bash", toolUses: 3 });
    expect(translateTaskMessage(sys("task_updated", { task_id: "a1", patch: { status: "failed", error: "vite build exited 1" } }), st)).toBeNull();
    expect(translateTaskMessage(sys("task_notification", { task_id: "a1", status: "failed", summary: "DONE", output_file: "/tmp/x.output", usage: { tool_uses: 3, duration_ms: 35140 } }), st))
      .toEqual({ type: "task_done", id: "a1", status: "failed", summary: "DONE", error: "vite build exited 1", toolUses: 3, durationMs: 35140, outputFile: "/tmp/x.output" });
  });

  it("marks worker_restart notifications as interrupted", () => {
    const st = fresh();
    st.known.add("a1");
    expect(translateTaskMessage(sys("task_notification", { task_id: "a1", status: "stopped", reason: "worker_restart", summary: "" }), st))
      .toMatchObject({ type: "task_done", id: "a1", status: "interrupted" });
  });
});
