import { describe, it, expect } from "vitest";
import { ClaudeBackend } from "./claude-backend.js";

describe("ClaudeBackend", () => {
  it("interrupt() resolves pending approvals as deny", async () => {
    const backend = new ClaudeBackend();
    // Simulate a pending approval by injecting into the internal map:
    const testResolve = new Promise<{ behavior: string }>((resolve) => {
      (backend as unknown as { pendingApprovals: Map<string, (v: unknown) => void> })
        .pendingApprovals.set("test-id", resolve as (v: unknown) => void);
    });
    await backend.interrupt();
    const decision = await testResolve;
    expect(decision).toMatchObject({ behavior: "deny" });
  });

  it("isResumeStaleError matches known Claude error strings", () => {
    const backend = new ClaudeBackend();
    expect(backend.isResumeStaleError(new Error("No conversation found"))).toBe(true);
    expect(backend.isResumeStaleError(new Error("session not found"))).toBe(true);
    expect(backend.isResumeStaleError(new Error("process exited with code 1"))).toBe(true);
    expect(backend.isResumeStaleError(new Error("random other error"))).toBe(false);
  });

  it("getAuthErrorHint returns claude login hint for auth errors", () => {
    const backend = new ClaudeBackend();
    expect(backend.getAuthErrorHint(new Error("credit balance too low"))).toContain("claude login");
    expect(backend.getAuthErrorHint(new Error("unauthorized"))).toContain("claude login");
    expect(backend.getAuthErrorHint(new Error("some other error"))).toBeNull();
  });
});
