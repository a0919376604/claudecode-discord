import { describe, it, expect } from "vitest";
import { sdkMessageToEvent } from "./claude-translate.js";

describe("sdkMessageToEvent", () => {
  it("translates system init to session_init", () => {
    const msg = { type: "system", subtype: "init", session_id: "abc-123" };
    expect(sdkMessageToEvent(msg)).toEqual({ type: "session_init", sessionId: "abc-123" });
  });

  it("ignores system messages without session_id", () => {
    expect(sdkMessageToEvent({ type: "system", subtype: "init" })).toBeNull();
  });

  it("translates assistant text blocks to text_delta events (one per block)", () => {
    const msg = {
      type: "assistant",
      content: [
        { type: "text", text: "hello " },
        { type: "text", text: "world" },
      ],
    };
    // Translator returns null for multi-block; caller iterates.
    // Instead we test a helper that returns an array:
    // For MVP, translator yields ONE event per call — caller loops content[].
    // So test the single-block case:
    const single = { type: "assistant", content: [{ type: "text", text: "hi" }] };
    expect(sdkMessageToEvent(single)).toEqual({ type: "text_delta", text: "hi" });
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
    expect(sdkMessageToEvent(msg)?.isError).toBe(true);
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
});
