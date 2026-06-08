import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockConfig, refresherMock } = vi.hoisted(() => ({
  mockConfig: {
    CLAUDE_AUTO_REFRESH: true,
    CLAUDE_REFRESH_THRESHOLD_MIN: 30,
    CLAUDE_REFRESH_INTERVAL_MIN: 60,
    ALLOWED_USER_IDS: ["111111111111111111"],
  },
  refresherMock: vi.fn(),
}));

vi.mock("../utils/config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
}));

vi.mock("./credentials-refresher.js", () => ({
  ensureFreshCredentials: refresherMock,
}));

import {
  startCredentialsHeartbeat,
  stopCredentialsHeartbeat,
} from "./credentials-heartbeat.js";

// Minimal Client stub. Heartbeat only touches client.users.fetch().send().
function makeFakeClient(opts: { sendFn?: ReturnType<typeof vi.fn> } = {}) {
  const sendFn = opts.sendFn ?? vi.fn().mockResolvedValue(undefined);
  const fetchFn = vi.fn().mockResolvedValue({ send: sendFn });
  return {
    client: { users: { fetch: fetchFn } } as unknown as import("discord.js").Client,
    fetchFn,
    sendFn,
  };
}

describe("credentials-heartbeat", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.useFakeTimers();
    refresherMock.mockReset().mockResolvedValue({ status: "skipped" });
    mockConfig.CLAUDE_AUTO_REFRESH = true;
    mockConfig.CLAUDE_REFRESH_INTERVAL_MIN = 60;
    mockConfig.ALLOWED_USER_IDS = ["111111111111111111"];
  });

  afterEach(() => {
    stopCredentialsHeartbeat();
    vi.useRealTimers();
    Object.defineProperty(process, "platform", { value: originalPlatform });
    vi.restoreAllMocks();
  });

  it("does not register a timer on non-darwin", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const { client } = makeFakeClient();
    startCredentialsHeartbeat(client);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000); // 24h
    expect(refresherMock).not.toHaveBeenCalled();
  });

  it("does not register a timer when CLAUDE_AUTO_REFRESH=false", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockConfig.CLAUDE_AUTO_REFRESH = false;
    const { client } = makeFakeClient();
    startCredentialsHeartbeat(client);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(refresherMock).not.toHaveBeenCalled();
  });

  it("is idempotent — second call does not stack timers", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const { client } = makeFakeClient();
    startCredentialsHeartbeat(client);
    startCredentialsHeartbeat(client);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // 1h
    expect(refresherMock).toHaveBeenCalledTimes(1);
  });

  it("stop() clears the timer", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const { client } = makeFakeClient();
    startCredentialsHeartbeat(client);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000); // 30 min, no tick yet
    stopCredentialsHeartbeat();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000); // 24h
    expect(refresherMock).not.toHaveBeenCalled();
  });

  it("stop() is safe when no timer is running", () => {
    expect(() => stopCredentialsHeartbeat()).not.toThrow();
  });

  // ----- Tick cadence -----

  it("does not fire before the first interval elapses", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const { client } = makeFakeClient();
    startCredentialsHeartbeat(client);
    await vi.advanceTimersByTimeAsync(59 * 60 * 1000); // 59 min
    expect(refresherMock).not.toHaveBeenCalled();
  });

  it("fires once at the first interval boundary", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const { client } = makeFakeClient();
    startCredentialsHeartbeat(client);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // 60 min
    expect(refresherMock).toHaveBeenCalledTimes(1);
  });

  it("fires repeatedly at the configured interval", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockConfig.CLAUDE_REFRESH_INTERVAL_MIN = 30;
    const { client } = makeFakeClient();
    startCredentialsHeartbeat(client);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(refresherMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(refresherMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(refresherMock).toHaveBeenCalledTimes(3);
  });

  // ----- Outcome handling -----

  it("does not DM on `skipped` outcome", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    refresherMock.mockResolvedValue({ status: "skipped" });
    const { client, sendFn } = makeFakeClient();
    startCredentialsHeartbeat(client);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(sendFn).not.toHaveBeenCalled();
  });

  it("does not DM on `refreshed` outcome", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    refresherMock.mockResolvedValue({ status: "refreshed", expiresAt: Date.now() + 8 * 3_600_000 });
    const { client, sendFn } = makeFakeClient();
    startCredentialsHeartbeat(client);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(sendFn).not.toHaveBeenCalled();
  });

  it("does not DM on `transient_error` outcome", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    refresherMock.mockResolvedValue({ status: "transient_error" });
    const { client, sendFn } = makeFakeClient();
    startCredentialsHeartbeat(client);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(sendFn).not.toHaveBeenCalled();
  });

  it("DMs the first ALLOWED_USER_IDS entry on `revoked`", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    refresherMock.mockResolvedValue({ status: "revoked" });
    const { client, fetchFn, sendFn } = makeFakeClient();
    startCredentialsHeartbeat(client);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(fetchFn).toHaveBeenCalledWith("111111111111111111");
    expect(sendFn).toHaveBeenCalledTimes(1);
    const sentText = sendFn.mock.calls[0][0] as string;
    expect(sentText).toContain("claude login");
    expect(sentText).toContain("재인증"); // KR copy present
  });

  it("does not DM twice for the same revocation cycle", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    refresherMock.mockResolvedValue({ status: "revoked" });
    const { client, sendFn } = makeFakeClient();
    startCredentialsHeartbeat(client);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // tick 1 → DM
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // tick 2 → no DM
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // tick 3 → no DM
    expect(sendFn).toHaveBeenCalledTimes(1);
  });

  it("re-DMs after a refreshed cycle followed by another revocation", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    refresherMock
      .mockResolvedValueOnce({ status: "revoked" })
      .mockResolvedValueOnce({ status: "refreshed", expiresAt: Date.now() + 8 * 3_600_000 })
      .mockResolvedValueOnce({ status: "revoked" });
    const { client, sendFn } = makeFakeClient();
    startCredentialsHeartbeat(client);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // DM #1
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // refreshed → reset
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // DM #2
    expect(sendFn).toHaveBeenCalledTimes(2);
  });

  it("does NOT reset notifiedRevoked on transient_error", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    refresherMock
      .mockResolvedValueOnce({ status: "revoked" })
      .mockResolvedValueOnce({ status: "transient_error" })
      .mockResolvedValueOnce({ status: "revoked" });
    const { client, sendFn } = makeFakeClient();
    startCredentialsHeartbeat(client);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // DM
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // transient, suppressed flag still set
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // revoked, but flag is still true → no DM
    expect(sendFn).toHaveBeenCalledTimes(1);
  });

  // ----- DM failure isolation -----

  it("tolerates client.users.fetch failure without crashing", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    refresherMock.mockResolvedValue({ status: "revoked" });
    const fetchFn = vi.fn().mockRejectedValue(new Error("Unknown user"));
    const client = { users: { fetch: fetchFn } } as unknown as import("discord.js").Client;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    startCredentialsHeartbeat(client);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(warnSpy).toHaveBeenCalled();
    // Next tick should still fire (timer not broken)
    refresherMock.mockResolvedValue({ status: "skipped" });
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(refresherMock).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it("tolerates user.send failure without crashing", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    refresherMock.mockResolvedValue({ status: "revoked" });
    const sendFn = vi.fn().mockRejectedValue(new Error("Cannot send messages to this user"));
    const { client } = makeFakeClient({ sendFn });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    startCredentialsHeartbeat(client);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(warnSpy).toHaveBeenCalled();
    // notifiedRevoked is set even when DM fails → no repeat DM
    refresherMock.mockResolvedValue({ status: "revoked" });
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(sendFn).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("tolerates refresher throwing (defense in depth)", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    refresherMock.mockRejectedValue(new Error("refresher exploded"));
    const { client, sendFn } = makeFakeClient();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    startCredentialsHeartbeat(client);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(sendFn).not.toHaveBeenCalled();
    // Timer should keep firing
    refresherMock.mockResolvedValue({ status: "skipped" });
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(refresherMock).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });
});
