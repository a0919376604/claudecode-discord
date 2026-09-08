import { describe, it, expect } from "vitest";
import { notificationToEvent } from "./codex-translate.js";

describe("notificationToEvent", () => {
  it("translates agentMessage/delta to text_delta", () => {
    const n = { method: "item/agentMessage/delta", params: { delta: "hello" } };
    expect(notificationToEvent(n)).toEqual({ type: "text_delta", text: "hello" });
  });

  it("translates reasoning/textDelta to text_delta with isReasoning", () => {
    const n = { method: "item/reasoning/textDelta", params: { delta: "thinking..." } };
    expect(notificationToEvent(n)).toEqual({ type: "text_delta", text: "thinking...", isReasoning: true });
  });

  it("translates item/started shell_command to tool_start", () => {
    const n = { method: "item/started", params: { item: { type: "shell_command", command: "ls" } } };
    expect(notificationToEvent(n)).toEqual({
      type: "tool_start",
      toolName: "Bash",
      input: { command: "ls" },
    });
  });

  it("translates item/started apply_patch to tool_start", () => {
    const n = { method: "item/started", params: { item: { type: "apply_patch", changes: [] } } };
    expect(notificationToEvent(n)).toMatchObject({ type: "tool_start", toolName: "Write" });
  });

  it("returns null for item/started with userMessage type", () => {
    const n = { method: "item/started", params: { item: { type: "userMessage", content: "hi" } } };
    expect(notificationToEvent(n)).toBeNull();
  });

  it("returns null for item/started with agentMessage type", () => {
    const n = { method: "item/started", params: { item: { type: "agentMessage" } } };
    expect(notificationToEvent(n)).toBeNull();
  });

  it("returns null for item/started with reasoning type", () => {
    const n = { method: "item/started", params: { item: { type: "reasoning" } } };
    expect(notificationToEvent(n)).toBeNull();
  });

  it("returns null for item/started with unknown item type", () => {
    const n = { method: "item/started", params: { item: { type: "someUnknownType" } } };
    expect(notificationToEvent(n)).toBeNull();
  });

  it("translates turn/completed success to result using accumulated text", () => {
    const n = { method: "turn/completed", params: {} };
    expect(notificationToEvent(n, "aggregated assistant reply")).toEqual({
      type: "result",
      text: "aggregated assistant reply",
      isError: false,
    });
  });

  it("translates turn/completed success with no accumulated text to empty result", () => {
    const n = { method: "turn/completed", params: {} };
    expect(notificationToEvent(n)).toEqual({ type: "result", text: "", isError: false });
  });

  it("translates turn/completed error to result with isError", () => {
    const n = { method: "turn/completed", params: { error: { message: "boom" } } };
    expect(notificationToEvent(n)).toMatchObject({ type: "result", isError: true, text: "boom" });
  });

  it("returns null for unknown method", () => {
    expect(notificationToEvent({ method: "item/mystery", params: {} })).toBeNull();
  });

  it("returns null for malformed params (does not throw)", () => {
    expect(notificationToEvent({ method: "item/agentMessage/delta", params: null })).toBeNull();
    expect(notificationToEvent({ method: "turn/completed", params: undefined })).toBeNull();
  });
});
