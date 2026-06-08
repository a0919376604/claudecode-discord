import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import * as child_process from "node:child_process";
import fs from "node:fs";

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

// Stub readServerNames indirectly via the underlying fs read.
// readServerNames is a pure function over fs.readFileSync output, so
// mocking the fs call gives deterministic control without spying on
// the module-level binding (which ESM imports make awkward).
function stubServers(names: string[]) {
  vi.spyOn(fs, "readFileSync").mockImplementation(() =>
    names.map((n) => `[servers.${n}]\nhost = "${n}"`).join("\n"),
  );
}

// Helper that builds a spawn mock dispatching on the first arg:
// - paths containing "vpn-status.sh" use the supplied status response
// - "ping" returns a successful empty exit
function spawnDispatcher(statusFactory: () => any) {
  return vi.spyOn(child_process, "spawn").mockImplementation((cmd: any, _args: any) => {
    if (String(cmd).includes("vpn-status.sh")) return statusFactory();
    if (String(cmd) === "ping") return makeFakeProcess({ exitCode: 0 }) as any;
    throw new Error("unexpected spawn: " + String(cmd));
  });
}

async function drainTick() {
  await vi.advanceTimersByTimeAsync(1);
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(1);
}

describe("vpn-keepalive: tick body", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.useFakeTimers();
    mockConfig.VPN_KEEPALIVE_ENABLED = true;
    mockConfig.VPN_KEEPALIVE_INTERVAL_SEC = 60;
    mockConfig.ALLOWED_USER_IDS = ["111111111111111111"];
    Object.defineProperty(process, "platform", { value: "darwin" });
  });

  afterEach(() => {
    stopVpnKeepalive();
    vi.useRealTimers();
    Object.defineProperty(process, "platform", { value: originalPlatform });
    vi.restoreAllMocks();
  });

  function statusUp() {
    return makeFakeProcess({
      stdout: "✅ FortiClient VPN connected — utun4 (10.50.10.42)\n",
      exitCode: 0,
    });
  }

  function statusDown() {
    return makeFakeProcess({
      stdout: "❌ FortiClient VPN not connected\n",
      exitCode: 0,
    });
  }

  function statusEnoent() {
    return makeFakeProcess({
      error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
    });
  }

  it("VPN up → spawns ping for each configured server", async () => {
    stubServers(["dl01", "dl02", "dl03", "dl04"]);
    const spawnSpy = spawnDispatcher(statusUp);
    const { client } = makeFakeClient();
    startVpnKeepalive(client);
    await vi.advanceTimersByTimeAsync(60_000);
    // Drain microtasks so the spawn dispatcher resolves all parallel pings.
    await drainTick();
    const pingCalls = spawnSpy.mock.calls.filter((c) => String(c[0]) === "ping");
    expect(pingCalls.length).toBe(4);
  });

  it("VPN up → no DM", async () => {
    stubServers(["dl01"]);
    spawnDispatcher(statusUp);
    const { client, sendFn } = makeFakeClient();
    startVpnKeepalive(client);
    await vi.advanceTimersByTimeAsync(60_000);
    await drainTick();
    expect(sendFn).not.toHaveBeenCalled();
  });

  it("VPN down (reason=down) → DM with EN+KR+zh-TW", async () => {
    stubServers(["dl01"]);
    spawnDispatcher(statusDown);
    const { client, fetchFn, sendFn } = makeFakeClient();
    startVpnKeepalive(client);
    await vi.advanceTimersByTimeAsync(60_000);
    await drainTick();
    expect(fetchFn).toHaveBeenCalledWith("111111111111111111");
    expect(sendFn).toHaveBeenCalledTimes(1);
    const sent = String(sendFn.mock.calls[0][0]);
    // All three languages must be present.
    expect(sent).toMatch(/VPN appears to be disconnected/);
    expect(sent).toMatch(/VPN 연결이 끊어진/);
    expect(sent).toMatch(/VPN 似乎已斷線/);
  });

  it("VPN down repeat → only one DM", async () => {
    stubServers(["dl01"]);
    spawnDispatcher(statusDown);
    const { client, sendFn } = makeFakeClient();
    startVpnKeepalive(client);
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(60_000);
      await drainTick();
    }
    expect(sendFn).toHaveBeenCalledTimes(1);
  });

  it("VPN recovery resets DM capability", async () => {
    stubServers(["dl01"]);
    let phase = 0;
    const sequence = [statusDown, statusUp, statusDown];
    spawnDispatcher(() => sequence[phase++ % sequence.length]());
    const { client, sendFn } = makeFakeClient();
    startVpnKeepalive(client);
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(60_000);
      await drainTick();
    }
    expect(sendFn).toHaveBeenCalledTimes(2);
  });

  it("DM with reason=script_missing copy when vpn-status.sh missing", async () => {
    stubServers(["dl01"]);
    spawnDispatcher(statusEnoent);
    const { client, sendFn } = makeFakeClient();
    startVpnKeepalive(client);
    await vi.advanceTimersByTimeAsync(60_000);
    await drainTick();
    expect(sendFn).toHaveBeenCalledTimes(1);
    const sent = String(sendFn.mock.calls[0][0]);
    expect(sent).toMatch(/vpn-status\.sh.*not found/);
    expect(sent).toMatch(/找不到/); // zh-TW
    expect(sent).toMatch(/찾을 수 없습니다/); // KR
  });

  it("notifiedDown does NOT reset on script_error sequence", async () => {
    stubServers(["dl01"]);
    let phase = 0;
    const errorStatus = () =>
      makeFakeProcess({ stderr: "boom", exitCode: 2 });
    const sequence = [statusDown, errorStatus, statusDown];
    spawnDispatcher(() => sequence[phase++ % sequence.length]());
    const { client, sendFn } = makeFakeClient();
    startVpnKeepalive(client);
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(60_000);
      await drainTick();
    }
    // First tick: DOWN → DM #1. Second: script_error → suppressed (flag still true).
    // Third: DOWN again → still suppressed because no recovery happened.
    expect(sendFn).toHaveBeenCalledTimes(1);
  });

  it("DM failure (send rejects) does not crash subsequent ticks", async () => {
    stubServers(["dl01"]);
    spawnDispatcher(statusDown);
    const sendFn = vi.fn().mockRejectedValue(new Error("DMs blocked"));
    const { client } = makeFakeClient({ sendFn });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    startVpnKeepalive(client);
    await vi.advanceTimersByTimeAsync(60_000);
    await drainTick();
    // Subsequent tick should still fire (timer not broken)
    await vi.advanceTimersByTimeAsync(60_000);
    await drainTick();
    expect(warnSpy).toHaveBeenCalled();
    expect(sendFn).toHaveBeenCalledTimes(1); // notifiedDown still true → no repeat
    warnSpy.mockRestore();
  });

  it("VPN up but no servers configured → no ping calls, log once", async () => {
    stubServers([]);
    const spawnSpy = spawnDispatcher(statusUp);
    const { client } = makeFakeClient();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    startVpnKeepalive(client);
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(60_000);
      await drainTick();
    }
    const pingCalls = spawnSpy.mock.calls.filter((c) => String(c[0]) === "ping");
    expect(pingCalls.length).toBe(0);
    const emptyLogs = logSpy.mock.calls.filter((c) =>
      String(c[0]).includes("no servers configured"),
    );
    expect(emptyLogs.length).toBe(1); // logged only ONCE per process
    logSpy.mockRestore();
  });
});
