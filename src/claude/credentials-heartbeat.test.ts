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
});
