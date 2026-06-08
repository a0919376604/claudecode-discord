import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import * as child_process from "node:child_process";
import { runDevsync, stripAnsi } from "./devsync-cli.js";

vi.mock("node:child_process");

function makeFakeChild(opts: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  error?: Error;
  delayMs?: number;
}) {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  proc.pid = 12345;

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

describe("runDevsync", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns ok=true with stdout on exit 0", async () => {
    vi.spyOn(child_process, "spawn").mockReturnValue(
      makeFakeChild({ stdout: "hello\n", exitCode: 0 }) as any,
    );
    const r = await runDevsync(["doctor"]);
    expect(r.ok).toBe(true);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("hello\n");
    expect(r.stderr).toBe("");
  });

  it("returns ok=false with stderr on non-zero exit", async () => {
    vi.spyOn(child_process, "spawn").mockReturnValue(
      makeFakeChild({ stderr: "bad happened", exitCode: 2 }) as any,
    );
    const r = await runDevsync(["stop", "ghost"]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe(2);
    expect(r.stderr).toBe("bad happened");
  });

  it("strips ANSI escape sequences from stdout and stderr", async () => {
    vi.spyOn(child_process, "spawn").mockReturnValue(
      makeFakeChild({
        stdout: "[32mgreen[0m text",
        stderr: "[31mred[0m err",
        exitCode: 0,
      }) as any,
    );
    const r = await runDevsync(["doctor"]);
    expect(r.stdout).toBe("green text");
    expect(r.stderr).toBe("red err");
  });

  it("returns code 127 with install hint on ENOENT", async () => {
    const err = new Error("spawn devsync ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    vi.spyOn(child_process, "spawn").mockReturnValue(
      makeFakeChild({ error: err }) as any,
    );
    const r = await runDevsync(["doctor"]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe(127);
    expect(r.stderr).toContain("devsync CLI not found");
    expect(r.stderr).toContain("uv tool install");
  });

  it("kills the process and returns code -1 on timeout", async () => {
    const fake = makeFakeChild({ delayMs: 10_000, exitCode: 0 });
    vi.spyOn(child_process, "spawn").mockReturnValue(fake as any);
    const promise = runDevsync(["doctor"], { timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(150);
    const r = await promise;
    expect(r.ok).toBe(false);
    expect(r.code).toBe(-1);
    expect(r.stderr).toContain("timed out");
    expect(fake.kill).toHaveBeenCalled();
  });
});

describe("stripAnsi", () => {
  it("removes color codes", () => {
    expect(stripAnsi("[32mgreen[0m")).toBe("green");
  });
  it("leaves plain text unchanged", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });
});

import os from "node:os";
import fs from "node:fs";
import { readServerNames } from "./devsync-cli.js";

describe("readServerNames", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns the keys of [servers.*] from config.toml", () => {
    vi.spyOn(os, "homedir").mockReturnValue("/fake/home");
    vi.spyOn(fs, "readFileSync").mockImplementation((p) => {
      if (String(p).endsWith("/.config/devsync/config.toml")) {
        return [
          "[defaults]",
          'remote_base = "/y"',
          "",
          "[servers.dl01]",
          'host = "dl01"',
          "",
          "[servers.dl02]",
          'host = "dl02"',
        ].join("\n");
      }
      throw new Error("unexpected path: " + String(p));
    });
    expect(readServerNames()).toEqual(["dl01", "dl02"]);
  });

  it("returns [] when config.toml is missing", () => {
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(readServerNames()).toEqual([]);
  });

  it("honors the homeDir override", () => {
    const calls: string[] = [];
    vi.spyOn(fs, "readFileSync").mockImplementation((p) => {
      calls.push(String(p));
      return "[servers.alpha]\n";
    });
    const out = readServerNames("/custom/home");
    expect(calls[0]).toBe("/custom/home/.config/devsync/config.toml");
    expect(out).toEqual(["alpha"]);
  });
});
