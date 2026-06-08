import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import * as child_process from "node:child_process";

const mockConfig = {
  VPN_KEEPALIVE_ENABLED: true,
  VPN_KEEPALIVE_INTERVAL_SEC: 60,
  ALLOWED_USER_IDS: ["111111111111111111"],
};

vi.mock("../utils/config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
}));

vi.mock("node:child_process");

import {
  startVpnKeepalive,
  stopVpnKeepalive,
  checkVpnStatus,
} from "./keepalive.js";

// Minimal Discord Client stub. Heartbeat only touches users.fetch().send().
function makeFakeClient(opts: { sendFn?: ReturnType<typeof vi.fn> } = {}) {
  const sendFn = opts.sendFn ?? vi.fn().mockResolvedValue(undefined);
  const fetchFn = vi.fn().mockResolvedValue({ send: sendFn });
  return {
    client: { users: { fetch: fetchFn } } as unknown as import("discord.js").Client,
    fetchFn,
    sendFn,
  };
}

// Builds a fake child process. Used by lifecycle tests AND
// reused by the checkVpnStatus tests added in Task 4.
function makeFakeProcess(opts: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  error?: Error;
  delayMs?: number;
} = {}) {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  setTimeout(() => {
    if (opts.error) {
      proc.emit("error", opts.error);
      return;
    }
    if (opts.stdout) proc.stdout.emit("data", Buffer.from(opts.stdout));
    if (opts.stderr) proc.stderr.emit("data", Buffer.from(opts.stderr));
    proc.emit("close", opts.exitCode ?? 0);
  }, opts.delayMs ?? 0);
  return proc;
}

describe("vpn-keepalive: lifecycle + no-op guards", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.useFakeTimers();
    mockConfig.VPN_KEEPALIVE_ENABLED = true;
    mockConfig.VPN_KEEPALIVE_INTERVAL_SEC = 60;
    mockConfig.ALLOWED_USER_IDS = ["111111111111111111"];
  });

  afterEach(() => {
    stopVpnKeepalive();
    vi.useRealTimers();
    Object.defineProperty(process, "platform", { value: originalPlatform });
    vi.restoreAllMocks();
  });

  it("does not register a timer on non-darwin", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const { client } = makeFakeClient();
    const spawnSpy = vi.spyOn(child_process, "spawn");
    startVpnKeepalive(client);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("does not register a timer when VPN_KEEPALIVE_ENABLED=false", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockConfig.VPN_KEEPALIVE_ENABLED = false;
    const { client } = makeFakeClient();
    const spawnSpy = vi.spyOn(child_process, "spawn");
    startVpnKeepalive(client);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("is idempotent — second call does not stack timers", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const { client } = makeFakeClient();
    const spawnSpy = vi
      .spyOn(child_process, "spawn")
      .mockImplementation(() => makeFakeProcess({ exitCode: 0 }) as any);
    startVpnKeepalive(client);
    startVpnKeepalive(client);
    await vi.advanceTimersByTimeAsync(60 * 1000);
    // One tick boundary crossed → exactly one vpn-status.sh spawn.
    const statusSpawns = spawnSpy.mock.calls.filter((c) =>
      String(c[0]).includes("vpn-status.sh"),
    );
    expect(statusSpawns.length).toBe(1);
  });

  it("stop() clears the timer", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const { client } = makeFakeClient();
    const spawnSpy = vi.spyOn(child_process, "spawn");
    startVpnKeepalive(client);
    await vi.advanceTimersByTimeAsync(30 * 1000); // 30s, no tick yet
    stopVpnKeepalive();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("stop() is safe when no timer is running", () => {
    expect(() => stopVpnKeepalive()).not.toThrow();
  });
});

describe("vpn-keepalive: checkVpnStatus", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns connected=true when stdout starts with ✅", async () => {
    vi.spyOn(child_process, "spawn").mockReturnValue(
      makeFakeProcess({
        stdout: "✅ FortiClient VPN connected — utun4 (10.50.10.42)\n",
        exitCode: 0,
      }) as any,
    );
    const r = await checkVpnStatus();
    expect(r.connected).toBe(true);
    if (r.connected) {
      expect(r.iface).toBe("utun4");
      expect(r.ip).toBe("10.50.10.42");
    }
  });

  it("returns connected=false reason='down' when stdout starts with ❌", async () => {
    vi.spyOn(child_process, "spawn").mockReturnValue(
      makeFakeProcess({
        stdout: "❌ FortiClient VPN not connected\n",
        exitCode: 0,
      }) as any,
    );
    const r = await checkVpnStatus();
    expect(r).toEqual({ connected: false, reason: "down" });
  });

  it("returns reason='script_missing' on ENOENT", async () => {
    const err = new Error("spawn ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    vi.spyOn(child_process, "spawn").mockReturnValue(
      makeFakeProcess({ error: err }) as any,
    );
    const r = await checkVpnStatus();
    expect(r).toEqual({ connected: false, reason: "script_missing" });
  });

  it("returns reason='script_error' on non-zero exit", async () => {
    vi.spyOn(child_process, "spawn").mockReturnValue(
      makeFakeProcess({ stderr: "broken", exitCode: 2 }) as any,
    );
    const r = await checkVpnStatus();
    expect(r).toEqual({ connected: false, reason: "script_error" });
  });

  it("returns reason='script_error' on unparseable stdout", async () => {
    vi.spyOn(child_process, "spawn").mockReturnValue(
      makeFakeProcess({
        stdout: "lol no leading icon here\n",
        exitCode: 0,
      }) as any,
    );
    const r = await checkVpnStatus();
    expect(r).toEqual({ connected: false, reason: "script_error" });
  });

  it("returns reason='script_error' on timeout and SIGKILLs", async () => {
    const fake = makeFakeProcess({ delayMs: 10_000, exitCode: 0 });
    vi.spyOn(child_process, "spawn").mockReturnValue(fake as any);
    const promise = checkVpnStatus();
    await vi.advanceTimersByTimeAsync(3500); // exceeds the 3s timeout
    const r = await promise;
    expect(r).toEqual({ connected: false, reason: "script_error" });
    expect(fake.kill).toHaveBeenCalledWith("SIGKILL");
  });
});
