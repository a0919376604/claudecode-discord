import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mutable mocked config so individual tests can override
const mockConfig = {
  CLAUDE_AUTO_REFRESH: true,
  CLAUDE_REFRESH_THRESHOLD_MIN: 30,
};

vi.mock("../utils/config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
}));

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";

import { ensureFreshCredentials } from "./credentials-refresher.js";

describe("ensureFreshCredentials", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    mockConfig.CLAUDE_AUTO_REFRESH = true;
    mockConfig.CLAUDE_REFRESH_THRESHOLD_MIN = 30;
    vi.mocked(execFileSync).mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    vi.restoreAllMocks();
  });

  it("no-ops on non-darwin platform", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    // mockResolvedValue is a safety net — if the implementation regresses
    // and DOES call fetch, the spy intercepts so we don't make a real HTTP
    // request from the test runner. The assertion still fails.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(""));
    await ensureFreshCredentials();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("no-ops when CLAUDE_AUTO_REFRESH is false", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockConfig.CLAUDE_AUTO_REFRESH = false;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(""));
    await ensureFreshCredentials();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("calls `security find-generic-password` to read the Keychain entry", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("The specified item could not be found in the keychain.");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(""));
    await ensureFreshCredentials();
    expect(execFileSync).toHaveBeenCalledWith(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      expect.any(Object),
    );
    warnSpy.mockRestore();
  });

  it("returns silently when Keychain entry is missing", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("The specified item could not be found in the keychain.");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(""));
    await ensureFreshCredentials();
    expect(fetchSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("returns silently when Keychain JSON is malformed", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    vi.mocked(execFileSync).mockReturnValue("not json at all\n" as never);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(""));
    await ensureFreshCredentials();
    expect(fetchSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  function mockKeychainCreds(overrides: Partial<{ expiresAt: number; refreshToken: string }> = {}) {
    const payload = JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-existing",
        refreshToken: overrides.refreshToken ?? "sk-ant-ort01-existing",
        expiresAt: overrides.expiresAt ?? Date.now() + 2 * 60 * 60 * 1000, // 2h out
        scopes: ["user:inference"],
        subscriptionType: "team",
        rateLimitTier: "default_claude_max_5x",
      },
    });
    vi.mocked(execFileSync).mockReturnValue(payload as never);
  }

  it("does not call fetch when token is well within threshold", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockKeychainCreds({ expiresAt: Date.now() + 2 * 60 * 60 * 1000 });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await ensureFreshCredentials();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("calls fetch when token expires within threshold", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockKeychainCreds({ expiresAt: Date.now() + 5 * 60 * 1000 }); // 5 min
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 28800,
      })),
    );
    await ensureFreshCredentials();
    expect(fetchSpy).toHaveBeenCalled();
  });
});
