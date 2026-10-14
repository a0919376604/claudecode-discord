import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InputCloser } from "./input-closer.js";

// Sequences mirror real SDK 0.3.293 runs (2026-10-14, streaming input,
// CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1): `idle` fires after EVERY turn,
// even while a background task is still running.
describe("InputCloser", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not close at idle while a background task is live", () => {
    const onClose = vi.fn();
    const c = new InputCloser(3000, onClose);
    c.live(1);
    c.state("idle");
    vi.advanceTimersByTime(10_000);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes after the grace period once idle with nothing live", () => {
    const onClose = vi.fn();
    const c = new InputCloser(3000, onClose);
    c.live(1);
    c.state("idle");
    c.live(0); // task finished…
    c.state("running"); // …its notification turn starts
    vi.advanceTimersByTime(10_000);
    expect(onClose).not.toHaveBeenCalled();
    c.state("idle");
    vi.advanceTimersByTime(2_999);
    expect(onClose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("cancels the pending close when a queued prompt starts running (resume after a stale notification)", () => {
    const onClose = vi.fn();
    const c = new InputCloser(3000, onClose);
    c.state("idle"); // the stale notification's turn ended
    vi.advanceTimersByTime(50);
    c.state("running"); // our prompt was dequeued
    vi.advanceTimersByTime(10_000);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("falls back to results when the CLI emits no state events", () => {
    const onClose = vi.fn();
    const c = new InputCloser(3000, onClose);
    c.live(1);
    c.result();
    vi.advanceTimersByTime(10_000);
    expect(onClose).not.toHaveBeenCalled();
    c.live(0);
    c.result();
    vi.advanceTimersByTime(3_000);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes at most once, and closeNow() is immediate", () => {
    const onClose = vi.fn();
    const c = new InputCloser(3000, onClose);
    c.closeNow();
    c.state("idle");
    vi.advanceTimersByTime(10_000);
    c.closeNow();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
