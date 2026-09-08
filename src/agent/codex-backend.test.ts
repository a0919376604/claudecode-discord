import { describe, it, expect } from "vitest";
import { CodexBackend } from "./codex-backend.js";

describe("CodexBackend", () => {
  it("isResumeStaleError matches codex-specific error strings", () => {
    const b = new CodexBackend();
    expect(b.isResumeStaleError(new Error("thread not found"))).toBe(true);
    expect(b.isResumeStaleError(new Error("invalid threadId"))).toBe(true);
    expect(b.isResumeStaleError(new Error("some unrelated error"))).toBe(false);
  });

  it("getAuthErrorHint returns codex login hint for auth errors", () => {
    const b = new CodexBackend();
    expect(b.getAuthErrorHint(new Error("unauthorized"))).toContain("codex login");
    expect(b.getAuthErrorHint(new Error("401"))).toContain("codex login");
    expect(b.getAuthErrorHint(new Error("random"))).toBeNull();
  });

  it("interrupt() resolves pending approvals even if RPC is null", async () => {
    const b = new CodexBackend();
    let resolved = false;
    (b as unknown as { pendingApprovals: Map<string, (v: string) => void> })
      .pendingApprovals.set("x", (d) => { resolved = d === "deny"; });
    await b.interrupt();
    expect(resolved).toBe(true);
  });
});
