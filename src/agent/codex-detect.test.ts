import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  exec: vi.fn(),
}));

import { exec } from "node:child_process";
import { detectCodex, _clearCache } from "./codex-detect.js";

const mockExec = vi.mocked(exec);

function mockExecOnce(response: { stdout?: string; stderr?: string; code?: number; error?: Error }) {
  mockExec.mockImplementationOnce(((_cmd: string, optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = typeof optsOrCb === "function" ? optsOrCb : maybeCb;
    if (response.error) (cb as (e: Error) => void)(response.error);
    else (cb as (e: null, out: { stdout: string; stderr: string }) => void)(null, {
      stdout: response.stdout ?? "",
      stderr: response.stderr ?? "",
    });
    return {} as never;
  }) as never);
}

describe("detectCodex", () => {
  beforeEach(() => {
    mockExec.mockReset();
    _clearCache();
  });

  it("returns ok when all three checks pass", async () => {
    mockExecOnce({ stdout: "/usr/local/bin/codex\n" });      // which codex
    mockExecOnce({ stdout: "codex 0.153.4\n" });              // codex --version
    mockExecOnce({ stdout: "Logged in as user@example.com\n" }); // codex auth status
    const r = await detectCodex();
    expect(r.ok).toBe(true);
  });

  it("returns install hint when codex not found", async () => {
    mockExecOnce({ error: new Error("Command not found") });
    const r = await detectCodex();
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain("npm install -g @openai/codex");
  });

  it("returns login hint when auth check fails", async () => {
    mockExecOnce({ stdout: "/usr/local/bin/codex\n" });
    mockExecOnce({ stdout: "codex 0.153.4\n" });
    mockExecOnce({ stderr: "not logged in", code: 1 });
    const r = await detectCodex();
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain("codex login");
  });

  it("caches the result across calls", async () => {
    mockExecOnce({ stdout: "/usr/local/bin/codex\n" });
    mockExecOnce({ stdout: "codex 0.153.4\n" });
    mockExecOnce({ stdout: "Logged in\n" });
    await detectCodex();
    await detectCodex();  // should not call exec again
    expect(mockExec).toHaveBeenCalledTimes(3);  // only from first call
  });
});
