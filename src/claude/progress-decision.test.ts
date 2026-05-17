import { describe, it, expect } from "vitest";
import {
  decideProgressAction,
  formatElapsed,
  buildProgressContent,
} from "./progress-decision.js";

describe("decideProgressAction", () => {
  const baseState = {
    hasTextOutput: false,
    lastTextTime: 0,
    now: 0,
    staleThresholdMs: 30_000,
    progressMessageExists: false,
  };

  // ─── Pre-text phase ───

  it("edits the current message before any text output", () => {
    expect(
      decideProgressAction({ ...baseState, hasTextOutput: false }),
    ).toBe("edit-current");
  });

  it("edits the current message even when stale threshold passed (pre-text)", () => {
    // No text yet — heartbeat should keep editing the Thinking message.
    expect(
      decideProgressAction({
        ...baseState,
        hasTextOutput: false,
        lastTextTime: 0,
        now: 10 * 60 * 1000, // 10 minutes
      }),
    ).toBe("edit-current");
  });

  // ─── Post-text phase, fresh text ───

  it("skips when text streamed recently — let streaming edits show", () => {
    // This is THE regression test for the UI-freeze bug. Before the fix,
    // after hasTextOutput became true the heartbeat would just return,
    // and tool progress was silently dropped for the rest of the session.
    // Now: when text is FRESH, we skip (streaming is still showing progress).
    expect(
      decideProgressAction({
        ...baseState,
        hasTextOutput: true,
        lastTextTime: 1_000,
        now: 5_000, // 4s since text — fresh
        staleThresholdMs: 30_000,
      }),
    ).toBe("skip");
  });

  // ─── Post-text phase, stale text ───

  it("sends a new progress message when stale and none exists", () => {
    // This is the CORE fix: after text output, when Claude has been silent
    // doing tool work for > stale threshold, we send a NEW message rather
    // than overwriting the streamed content.
    expect(
      decideProgressAction({
        ...baseState,
        hasTextOutput: true,
        lastTextTime: 0,
        now: 35_000, // 35s since text — stale
        staleThresholdMs: 30_000,
        progressMessageExists: false,
      }),
    ).toBe("send-progress");
  });

  it("edits existing progress message when stale and one exists", () => {
    // Once we've sent a progress message, subsequent stale ticks should
    // update it in place rather than spamming new messages.
    expect(
      decideProgressAction({
        ...baseState,
        hasTextOutput: true,
        lastTextTime: 0,
        now: 60_000,
        staleThresholdMs: 30_000,
        progressMessageExists: true,
      }),
    ).toBe("edit-progress");
  });

  it("treats exactly-at-threshold as stale", () => {
    // Boundary case — at exactly stale threshold, send progress.
    expect(
      decideProgressAction({
        ...baseState,
        hasTextOutput: true,
        lastTextTime: 0,
        now: 30_000,
        staleThresholdMs: 30_000,
      }),
    ).toBe("send-progress");
  });
});

describe("formatElapsed", () => {
  it("formats seconds when under a minute", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(5_000)).toBe("5s");
    expect(formatElapsed(59_000)).toBe("59s");
  });

  it("formats minutes + seconds under an hour", () => {
    expect(formatElapsed(60_000)).toBe("1m 0s");
    expect(formatElapsed(90_000)).toBe("1m 30s");
    expect(formatElapsed(59 * 60_000)).toBe("59m 0s");
  });

  it("formats hours + minutes at or above an hour", () => {
    // The very scenario the user hit — an hour-long session with frozen UI.
    // The progress line should now read sensibly when this happens.
    expect(formatElapsed(60 * 60_000)).toBe("1h 0m");
    expect(formatElapsed(65 * 60_000)).toBe("1h 5m");
    expect(formatElapsed(2 * 60 * 60_000 + 30 * 60_000)).toBe("2h 30m");
  });

  it("rounds to nearest second and clamps negatives to zero", () => {
    expect(formatElapsed(499)).toBe("0s");
    expect(formatElapsed(500)).toBe("1s"); // Math.round rounds .5 up
    expect(formatElapsed(-5_000)).toBe("0s");
  });
});

describe("buildProgressContent", () => {
  it("omits tool count when zero", () => {
    // Initial Thinking state — no tools yet — should stay clean.
    expect(buildProgressContent("Thinking...", 3_000, 0)).toBe(
      "⏳ Thinking... (3s)",
    );
  });

  it("includes tool count when at least one tool has run", () => {
    expect(buildProgressContent("Reading files", 5_000, 1)).toBe(
      "⏳ Reading files (5s) [1 tools used]",
    );
  });

  it("works with long-running sessions", () => {
    expect(
      buildProgressContent("Searching code", 65 * 60_000, 142),
    ).toBe("⏳ Searching code (1h 5m) [142 tools used]");
  });
});
