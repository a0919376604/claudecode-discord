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

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    default: { ...actual, userInfo: vi.fn(() => ({ username: "testuser", uid: 0, gid: 0, shell: null, homedir: "/tmp" })) },
    userInfo: vi.fn(() => ({ username: "testuser", uid: 0, gid: 0, shell: null, homedir: "/tmp" })),
  };
});

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

  it("POSTs the correct body to the refresh endpoint", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockKeychainCreds({
      expiresAt: Date.now() + 5 * 60 * 1000,
      refreshToken: "sk-ant-ort01-the-current-one",
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 28800,
      })),
    );
    await ensureFreshCredentials();
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://platform.claude.com/v1/oauth/token",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: "sk-ant-ort01-the-current-one",
          client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
        }),
      }),
    );
  });

  it("does not write Keychain on 401 (invalid_grant)", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockKeychainCreds({ expiresAt: Date.now() + 5 * 60 * 1000 });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401 }),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await ensureFreshCredentials();
    // Only the READ exec call should have happened — no write.
    const writeCalls = vi.mocked(execFileSync).mock.calls.filter(
      (call) => Array.isArray(call[1]) && call[1].includes("add-generic-password"),
    );
    expect(writeCalls).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it("retries once on 5xx, then gives up", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockKeychainCreds({ expiresAt: Date.now() + 5 * 60 * 1000 });
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 503 }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await ensureFreshCredentials();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it("writes refreshed creds back to Keychain preserving subscriptionType and scopes", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockKeychainCreds({ expiresAt: Date.now() + 5 * 60 * 1000 });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        access_token: "sk-ant-oat01-new",
        refresh_token: "sk-ant-ort01-new",
        expires_in: 28800,
      })),
    );

    await ensureFreshCredentials();

    const writeCall = vi.mocked(execFileSync).mock.calls.find(
      (call) => Array.isArray(call[1]) && call[1].includes("add-generic-password"),
    );
    expect(writeCall).toBeDefined();
    const args = writeCall![1] as string[];
    const wIdx = args.indexOf("-w");
    const payload = JSON.parse(args[wIdx + 1]);
    expect(payload.claudeAiOauth.accessToken).toBe("sk-ant-oat01-new");
    expect(payload.claudeAiOauth.refreshToken).toBe("sk-ant-ort01-new");
    expect(payload.claudeAiOauth.subscriptionType).toBe("team");
    expect(payload.claudeAiOauth.scopes).toEqual(["user:inference"]);
    expect(payload.claudeAiOauth.rateLimitTier).toBe("default_claude_max_5x");
    // expiresAt should be ~now + 28800 * 1000
    const expectedExpiry = Date.now() + 28800 * 1000;
    expect(Math.abs(payload.claudeAiOauth.expiresAt - expectedExpiry)).toBeLessThan(5000);
    // -U flag for update-if-exists
    expect(args).toContain("-U");
    // -a flag uses os.userInfo().username (mocked to "testuser")
    const aIdx = args.indexOf("-a");
    expect(args[aIdx + 1]).toBe("testuser");
  });

  it("preserves existing refresh token if response omits it", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockKeychainCreds({
      expiresAt: Date.now() + 5 * 60 * 1000,
      refreshToken: "sk-ant-ort01-original",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        access_token: "sk-ant-oat01-new",
        // no refresh_token
        expires_in: 28800,
      })),
    );

    await ensureFreshCredentials();

    const writeCall = vi.mocked(execFileSync).mock.calls.find(
      (call) => Array.isArray(call[1]) && call[1].includes("add-generic-password"),
    );
    const args = writeCall![1] as string[];
    const payload = JSON.parse(args[args.indexOf("-w") + 1]);
    expect(payload.claudeAiOauth.refreshToken).toBe("sk-ant-ort01-original");
  });

  it("deduplicates concurrent calls", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockKeychainCreds({ expiresAt: Date.now() + 5 * 60 * 1000 });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        access_token: "sk-ant-oat01-new",
        refresh_token: "sk-ant-ort01-new",
        expires_in: 28800,
      })),
    );

    await Promise.all([
      ensureFreshCredentials(),
      ensureFreshCredentials(),
      ensureFreshCredentials(),
      ensureFreshCredentials(),
      ensureFreshCredentials(),
    ]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const writeCalls = vi.mocked(execFileSync).mock.calls.filter(
      (call) => Array.isArray(call[1]) && call[1].includes("add-generic-password"),
    );
    expect(writeCalls).toHaveLength(1);
  });
});
