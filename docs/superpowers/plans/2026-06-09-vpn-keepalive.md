# VPN Keep-Alive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a periodic in-process timer that pings the dev servers from `~/.config/devsync/config.toml` to keep FortiClient VPN's tunnel hot, and DMs the first allowed user when VPN status detection reports the tunnel is down.

**Architecture:** New module `src/vpn/keepalive.ts` owns a `setInterval`. Each tick spawns `~/bin/vpn-status.sh` to check VPN state; when UP, fire ICMP pings against each `[servers.*]` host from devsync config in parallel; when DOWN, DM the first `ALLOWED_USER_IDS` entry using the claim-first suppression pattern already in `credentials-heartbeat.ts`. Default OFF — this is a leric-specific feature that depends on user-specific files.

**Tech Stack:** TypeScript (ESM), Vitest with fake timers, discord.js v14, Zod v4 for config, Node's `child_process.spawn` for both vpn-status.sh and ping. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-09-vpn-keepalive-design.md`

---

## File Structure

**New files:**
- `src/vpn/keepalive.ts` — owns the timer, tick body, VPN status detection, ping spawning, DM dispatch
- `src/vpn/keepalive.test.ts` — vitest fake timers, mocked `child_process.spawn`, mocked Discord client

**Modified files:**
- `src/utils/devsync-cli.ts` — receive `readServerNames` (moved from commands)
- `src/utils/devsync-cli.test.ts` — gain a small direct unit test for `readServerNames`
- `src/bot/commands/devsync.ts` — drop the local `readServerNames` definition; import from `../../utils/devsync-cli.js`
- `src/utils/config.ts` — add `VPN_KEEPALIVE_ENABLED` and `VPN_KEEPALIVE_INTERVAL_SEC`
- `src/index.ts` — call `startVpnKeepalive(client)` after `startCredentialsHeartbeat`; add `stopVpnKeepalive()` to both signal handlers
- `docs/TESTING.md` and `docs/TESTING.kr.md` — append manual smoke test section

**Unchanged on purpose:**
- `src/bot/commands/devsync.test.ts` — the autocomplete tests there exercise `readServerNames` indirectly via the `autocomplete()` entry point. Re-pointing the export does not break them.
- `~/bin/vpn-status.sh` and `/vpn` slash command — out of scope; keep-alive consumes them as-is.

---

## Task 1: Move `readServerNames` to `src/utils/devsync-cli.ts`

**Files:**
- Modify: `src/bot/commands/devsync.ts` (drop local definition + add import)
- Modify: `src/utils/devsync-cli.ts` (add the function + its imports)
- Modify: `src/utils/devsync-cli.test.ts` (add a direct unit test)

No behavior change. Pure refactor so the upcoming `src/vpn/keepalive.ts` can import `readServerNames` without reaching into `src/bot/commands/` (a wrong-direction dependency).

- [ ] **Step 1: Add the failing test in `devsync-cli.test.ts`**

Append to `src/utils/devsync-cli.test.ts` (a new `describe` block at the file bottom, after the existing `describe("stripAnsi", ...)` block):

```typescript
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/utils/devsync-cli.test.ts -t "readServerNames"`
Expected: FAIL — `Cannot find module './devsync-cli.js'` export for `readServerNames`, OR `readServerNames is not a function`.

- [ ] **Step 3: Add `readServerNames` to `src/utils/devsync-cli.ts`**

Edit `src/utils/devsync-cli.ts`. Add these two imports at the top of the file (alongside the existing `import { spawn } from "node:child_process";`):

```typescript
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
```

Then append this function to the bottom of the file:

```typescript
/**
 * Parse the `[servers.*]` table headers from `~/.config/devsync/config.toml`
 * and return the server names. Tolerates missing file (returns [])
 * and malformed TOML (best-effort substring match — callers treat
 * this as advisory).
 *
 * Moved from src/bot/commands/devsync.ts so non-command modules
 * (e.g., src/vpn/keepalive.ts) can consume it without a wrong-
 * direction dependency on commands/.
 */
export function readServerNames(homeDir?: string): string[] {
  const cfgPath = path.join(
    homeDir ?? os.homedir(),
    ".config",
    "devsync",
    "config.toml",
  );
  let text: string;
  try {
    text = fs.readFileSync(cfgPath, "utf-8");
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^\[servers\.([^\]\s]+)\]$/);
    if (m) names.push(m[1]);
  }
  return names;
}
```

- [ ] **Step 4: Run the new test, verify it passes**

Run: `npx vitest run src/utils/devsync-cli.test.ts -t "readServerNames"`
Expected: 3 tests pass.

- [ ] **Step 5: Drop the local `readServerNames` from `devsync.ts` and import from utils**

Edit `src/bot/commands/devsync.ts`. Find the current `readServerNames` export (lines ~109-128, starting with `export function readServerNames(homeDir?: string): string[] {`) and DELETE the entire function definition.

Then add `readServerNames` to the existing import from `devsync-cli.js` near the top of the file. The current import line is:

```typescript
import { runDevsync, type DevsyncResult } from "../../utils/devsync-cli.js";
```

Change it to:

```typescript
import { runDevsync, readServerNames, type DevsyncResult } from "../../utils/devsync-cli.js";
```

- [ ] **Step 6: Run the full test suite to confirm autocomplete tests still pass**

Run: `npx vitest run src/bot/commands/devsync.test.ts src/utils/devsync-cli.test.ts`
Expected: every test in both files passes. The autocomplete tests in `devsync.test.ts` (around lines 333-380) exercise `readServerNames` via `autocomplete()` and must still be green.

- [ ] **Step 7: Type check**

Run: `npx tsc --noEmit`
Expected: clean exit.

- [ ] **Step 8: Commit**

```bash
git add src/utils/devsync-cli.ts src/utils/devsync-cli.test.ts src/bot/commands/devsync.ts
git commit -m "$(cat <<'EOF'
refactor(devsync): move readServerNames to utils/devsync-cli

Moves the config.toml parser out of the Discord command file so
non-command modules (next commit: src/vpn/keepalive.ts) can import
it without a wrong-direction dependency on commands/. Pure refactor:
the command-side autocomplete still works through the new import.

Adds three small direct unit tests for readServerNames in
devsync-cli.test.ts to anchor it as a standalone function. The
existing autocomplete tests in devsync.test.ts continue to cover
the integration path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add `VPN_KEEPALIVE_ENABLED` and `VPN_KEEPALIVE_INTERVAL_SEC` config

**Files:**
- Modify: `src/utils/config.ts`

Two env vars: a master switch (default OFF — this is a leric-specific feature) and the tick interval. Field coverage is exercised through the heartbeat tests in Tasks 3-5 (TypeScript will catch a missing field the moment those tests reference `cfg.VPN_KEEPALIVE_ENABLED`).

- [ ] **Step 1: Add the schema entries**

Edit `src/utils/config.ts`. Insert these two entries inside the `envSchema` `z.object`, immediately after the existing `CLAUDE_REFRESH_INTERVAL_MIN` line (which sits between `CLAUDE_REFRESH_THRESHOLD_MIN` and `WAKEUP_DIR_OVERRIDE`):

```typescript
  // Master switch for the VPN keep-alive feature. When true, a
  // periodic timer pings the dev servers from
  // ~/.config/devsync/config.toml so FortiClient's tunnel does
  // not drop from idle. Default FALSE — depends on leric-specific
  // files (~/bin/vpn-status.sh + devsync config); public open-
  // source users opt in by setting this to "true" in .env.
  VPN_KEEPALIVE_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // Seconds between keep-alive ticks. Lower bound 10 (no need to
  // hammer; FortiClient idle timer is minutes-scale). Upper bound
  // 600 (anything longer risks crossing the idle timeout).
  // Default 60 — one tick per minute, four pings per tick at
  // four servers = trivial network cost.
  VPN_KEEPALIVE_INTERVAL_SEC: z.coerce.number().int().min(10).max(600).default(60),
```

- [ ] **Step 2: Run the type checker**

Run: `npx tsc --noEmit`
Expected: clean exit.

- [ ] **Step 3: Run the full test suite to confirm no regression**

Run: `npm test`
Expected: every existing test still passes. Both new env vars have defaults, so existing test fixtures continue to work.

- [ ] **Step 4: Commit**

```bash
git add src/utils/config.ts
git commit -m "$(cat <<'EOF'
feat(config): add VPN_KEEPALIVE_ENABLED and INTERVAL_SEC env vars

Two env vars for the upcoming VPN keep-alive module. Master switch
defaults to false because the feature depends on leric-specific
files (~/bin/vpn-status.sh + devsync config); public open-source
users are unaffected unless they explicitly enable it.

Interval default 60s, range [10, 600]. Tight enough margin against
FortiClient's minutes-scale idle timer; loose enough to avoid
hammering. Hidden knob — not advertised in README.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Create `src/vpn/keepalive.ts` skeleton — start/stop API

**Files:**
- Create: `src/vpn/keepalive.ts`
- Create: `src/vpn/keepalive.test.ts`

Just the lifecycle scaffolding: `startVpnKeepalive` registers a `setInterval`, `stopVpnKeepalive` clears it. The tick body just exists as a stub that calls a placeholder `checkVpnStatus()` returning `{connected: true, iface: "stub", ip: "0.0.0.0"}`. Filled in by Tasks 4-5.

- [ ] **Step 1: Write the failing tests for lifecycle + no-op guards**

Create `src/vpn/keepalive.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/vpn/keepalive.test.ts`
Expected: FAIL — "Cannot find module './keepalive.js'".

- [ ] **Step 3: Create the keepalive module**

Create `src/vpn/keepalive.ts`:

```typescript
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import type { Client } from "discord.js";
import { getConfig } from "../utils/config.js";

let timer: NodeJS.Timeout | null = null;

/**
 * Start the periodic VPN keep-alive timer.
 *
 * No-op (does not register a timer) when:
 *   - VPN_KEEPALIVE_ENABLED is false (the default)
 *   - process.platform !== "darwin"
 *
 * Safe to call multiple times — second call is a no-op if a timer
 * is already running.
 */
export function startVpnKeepalive(client: Client): void {
  if (timer) return;
  const cfg = getConfig();
  if (!cfg.VPN_KEEPALIVE_ENABLED) return;
  if (process.platform !== "darwin") return;

  const intervalMs = cfg.VPN_KEEPALIVE_INTERVAL_SEC * 1000;
  timer = setInterval(() => void tick(client), intervalMs);
}

/**
 * Stop the periodic timer. Safe to call when no timer is running.
 */
export function stopVpnKeepalive(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function tick(_client: Client): Promise<void> {
  // Body filled out in Tasks 4-5. For now, just spawn vpn-status.sh
  // so the lifecycle tests can observe the call (proves the timer
  // is wired correctly).
  await checkVpnStatusStub();
}

async function checkVpnStatusStub(): Promise<void> {
  const scriptPath = path.join(os.homedir(), "bin", "vpn-status.sh");
  return new Promise<void>((resolve) => {
    const proc = spawn(scriptPath, [], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.on("close", () => resolve());
    proc.on("error", () => resolve());
  });
}
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `npx vitest run src/vpn/keepalive.test.ts`
Expected: ALL 5 lifecycle tests pass.

- [ ] **Step 5: Run type checker**

Run: `npx tsc --noEmit`
Expected: clean exit.

- [ ] **Step 6: Commit**

```bash
git add src/vpn/keepalive.ts src/vpn/keepalive.test.ts
git commit -m "$(cat <<'EOF'
feat(vpn-keepalive): start/stop skeleton with platform/enabled guards

New module owns a setInterval that will periodically check VPN
status and ping the dev servers from devsync config. Skeleton
commit: no-ops on non-darwin or when VPN_KEEPALIVE_ENABLED=false;
idempotent start; clean stop. Tick body currently just spawns
vpn-status.sh — full check + ping + DM lands in the next two commits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Implement `checkVpnStatus` — parse `vpn-status.sh` output

**Files:**
- Modify: `src/vpn/keepalive.ts`
- Modify: `src/vpn/keepalive.test.ts`

Replace the stub with a real implementation that spawns `~/bin/vpn-status.sh`, parses stdout, and returns a discriminated `VpnStatus`. Tests cover all five outcomes: ✅, ❌, ENOENT, exit-nonzero, timeout.

- [ ] **Step 1: Update the existing import to add `checkVpnStatus`**

Find this existing line near the top of `src/vpn/keepalive.test.ts` (added in Task 3):

```typescript
import {
  startVpnKeepalive,
  stopVpnKeepalive,
} from "./keepalive.js";
```

Replace with:

```typescript
import {
  startVpnKeepalive,
  stopVpnKeepalive,
  checkVpnStatus,
} from "./keepalive.js";
```

`EventEmitter`, `child_process`, and the `makeFakeProcess` helper were
already added in Task 3 — do NOT re-import or re-define them.

- [ ] **Step 2: Write the failing tests for `checkVpnStatus`**

Append a new describe block to the bottom of `src/vpn/keepalive.test.ts`:

```typescript
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/vpn/keepalive.test.ts -t "checkVpnStatus"`
Expected: FAIL — `checkVpnStatus` is not exported / not defined.

- [ ] **Step 4: Replace `checkVpnStatusStub` with the real `checkVpnStatus`**

Edit `src/vpn/keepalive.ts`. Add the `VpnStatus` type at the top of the file (just below the imports):

```typescript
export type VpnStatus =
  | { connected: true; iface: string; ip: string }
  | { connected: false; reason: "down" | "script_missing" | "script_error" };
```

Then DELETE the existing `checkVpnStatusStub` function and REPLACE it with the real one:

```typescript
const VPN_STATUS_TIMEOUT_MS = 3000;

/**
 * Spawn ~/bin/vpn-status.sh and parse its stdout. Returns a
 * discriminated VpnStatus. Never throws — every failure path
 * is captured as `connected: false`.
 *
 * Exported for unit testing; not used by callers outside this module.
 */
export function checkVpnStatus(): Promise<VpnStatus> {
  const scriptPath = path.join(os.homedir(), "bin", "vpn-status.sh");
  return new Promise<VpnStatus>((resolve) => {
    let stdout = "";
    let settled = false;
    const settle = (s: VpnStatus) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(s);
    };

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(scriptPath, [], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      settle({ connected: false, reason: "script_missing" });
      return;
    }

    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* ignore */ }
      settle({ connected: false, reason: "script_error" });
    }, VPN_STATUS_TIMEOUT_MS);

    proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });

    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        settle({ connected: false, reason: "script_missing" });
      } else {
        settle({ connected: false, reason: "script_error" });
      }
    });

    proc.on("close", (code) => {
      if ((code ?? 0) !== 0) {
        settle({ connected: false, reason: "script_error" });
        return;
      }
      const trimmed = stdout.trimStart();
      if (trimmed.startsWith("✅")) {
        // Example: "✅ FortiClient VPN connected — utun4 (10.50.10.42)\n..."
        const m = trimmed.match(/^✅[^—]*—\s*(\S+)\s*\(([^)]+)\)/);
        if (m) {
          settle({ connected: true, iface: m[1], ip: m[2] });
          return;
        }
        // Connected per the icon but we couldn't parse iface/ip —
        // treat as script_error so the caller surfaces a problem.
        settle({ connected: false, reason: "script_error" });
        return;
      }
      if (trimmed.startsWith("❌")) {
        settle({ connected: false, reason: "down" });
        return;
      }
      settle({ connected: false, reason: "script_error" });
    });
  });
}
```

Also update the `tick` function to use the real `checkVpnStatus` (still does nothing else for now — Task 5 fills in ping + DM):

```typescript
async function tick(_client: Client): Promise<void> {
  const status = await checkVpnStatus();
  // Task 5: act on `status`. For now, just log so cadence tests have
  // observable side-effects.
  if (!status.connected) {
    console.log(`[vpn-keepalive] VPN ${status.reason}.`);
  } else {
    console.log(`[vpn-keepalive] VPN up on ${status.iface} (${status.ip}).`);
  }
}
```

- [ ] **Step 5: Run checkVpnStatus tests, verify they pass**

Run: `npx vitest run src/vpn/keepalive.test.ts -t "checkVpnStatus"`
Expected: ALL 6 tests pass.

- [ ] **Step 6: Run the full keepalive test file (lifecycle + status both green)**

Run: `npx vitest run src/vpn/keepalive.test.ts`
Expected: ALL tests pass (5 lifecycle + 6 status = 11).

- [ ] **Step 7: Type check**

Run: `npx tsc --noEmit`
Expected: clean exit.

- [ ] **Step 8: Commit**

```bash
git add src/vpn/keepalive.ts src/vpn/keepalive.test.ts
git commit -m "$(cat <<'EOF'
feat(vpn-keepalive): VpnStatus detection via ~/bin/vpn-status.sh

Replaces the lifecycle stub with a real checkVpnStatus() that
spawns ~/bin/vpn-status.sh, parses the leading ✅/❌ icon, and
returns a discriminated VpnStatus union covering connected, down,
script_missing, script_error. 3-second timeout with SIGKILL on
overrun. Never throws — every failure path maps to a status value.

tick() now logs the detected status. Ping + DM behavior lands in
the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Tick body — ping on UP, claim-first DM on DOWN

**Files:**
- Modify: `src/vpn/keepalive.ts`
- Modify: `src/vpn/keepalive.test.ts`

Add `notifiedDown` flag with claim-first semantics, the four DM message variants (EN+KR+zh-TW), `notifyVpnDown`, and the parallel ping spawning.

- [ ] **Step 1: Add an `fs` import to the test file**

Find the top of `src/vpn/keepalive.test.ts` and add this import alongside the existing `EventEmitter` / `child_process` imports (which were added in Task 3):

```typescript
import fs from "node:fs";
```

- [ ] **Step 2: Write the failing tests for the full tick behavior**

Append to `src/vpn/keepalive.test.ts`:

```typescript
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
    await vi.advanceTimersByTimeAsync(0);
    const pingCalls = spawnSpy.mock.calls.filter((c) => String(c[0]) === "ping");
    expect(pingCalls.length).toBe(4);
  });

  it("VPN up → no DM", async () => {
    stubServers(["dl01"]);
    spawnDispatcher(statusUp);
    const { client, sendFn } = makeFakeClient();
    startVpnKeepalive(client);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(sendFn).not.toHaveBeenCalled();
  });

  it("VPN down (reason=down) → DM with EN+KR+zh-TW", async () => {
    stubServers(["dl01"]);
    spawnDispatcher(statusDown);
    const { client, fetchFn, sendFn } = makeFakeClient();
    startVpnKeepalive(client);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(0);
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
      await vi.advanceTimersByTimeAsync(0);
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
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(sendFn).toHaveBeenCalledTimes(2);
  });

  it("DM with reason=script_missing copy when vpn-status.sh missing", async () => {
    stubServers(["dl01"]);
    spawnDispatcher(statusEnoent);
    const { client, sendFn } = makeFakeClient();
    startVpnKeepalive(client);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(0);
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
      await vi.advanceTimersByTimeAsync(0);
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
    await vi.advanceTimersByTimeAsync(0);
    // Subsequent tick should still fire (timer not broken)
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(0);
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
      await vi.advanceTimersByTimeAsync(0);
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/vpn/keepalive.test.ts -t "tick body"`
Expected: most tests FAIL — current tick body only logs, doesn't ping or DM.

- [ ] **Step 4: Replace `tick` body with the full implementation**

Edit `src/vpn/keepalive.ts`. First, add the `readServerNames` import alongside the existing imports:

```typescript
import { readServerNames } from "../utils/devsync-cli.js";
```

Then add this module-level state below the existing `let timer: ... | null = null;` line:

```typescript
// Suppresses repeat DMs while VPN remains in a down state. Reset
// only on a true `connected: true` outcome (NOT on script_error
// or script_missing — those persist across ticks and re-DMing
// would be spam).
let notifiedDown = false;

// Ensures the "VPN up but no servers configured" log fires at
// most once per process lifetime. Resets if the process restarts.
let loggedEmptyServers = false;
```

Then DELETE the existing placeholder `tick` and REPLACE with:

```typescript
async function tick(client: Client): Promise<void> {
  let status: VpnStatus;
  try {
    status = await checkVpnStatus();
  } catch (e) {
    // Defense in depth — checkVpnStatus contract says it never throws.
    console.warn(
      "[vpn-keepalive] checkVpnStatus threw (should not happen):",
      e instanceof Error ? e.message : e,
    );
    return;
  }

  if (!status.connected) {
    if (notifiedDown) {
      console.log(`[vpn-keepalive] VPN still ${status.reason}, no DM.`);
      return;
    }
    // Claim-first: set flag BEFORE awaiting DM. Guarantees at most
    // one DM per drop event even if the DM path throws unexpectedly.
    notifiedDown = true;
    await notifyVpnDown(client, status.reason);
    return;
  }

  // VPN is up.
  if (notifiedDown) {
    notifiedDown = false;
    console.log("[vpn-keepalive] VPN recovered.");
  }

  const servers = readServerNames();
  if (servers.length === 0) {
    if (!loggedEmptyServers) {
      loggedEmptyServers = true;
      console.log(
        "[vpn-keepalive] VPN up but no servers configured — nothing to ping.",
      );
    }
    return;
  }
  // Fire-and-forget parallel pings. Each ping's outcome does NOT
  // affect the DM path — the keep-alive's job is to generate
  // traffic, not to verify connectivity.
  await Promise.all(servers.map((host) => pingHost(host)));
}

function pingHost(host: string): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn("ping", ["-c", "1", "-W", "1000", host], {
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {
      done();
      return;
    }
    proc.on("error", () => done());
    proc.on("close", () => done());
  });
}

async function notifyVpnDown(
  client: Client,
  reason: "down" | "script_missing" | "script_error",
): Promise<void> {
  try {
    const cfg = getConfig();
    const firstUserId = cfg.ALLOWED_USER_IDS[0];
    if (!firstUserId) return;
    const user = await client.users.fetch(firstUserId);
    await user.send(messageFor(reason));
    console.log(`[vpn-keepalive] Sent VPN-${reason} DM to first allowed user.`);
  } catch (e) {
    console.warn(
      "[vpn-keepalive] Failed to DM VPN-down notice:",
      e instanceof Error ? e.message : e,
    );
  }
}

function messageFor(reason: "down" | "script_missing" | "script_error"): string {
  if (reason === "down") {
    return (
      "🔌 VPN appears to be disconnected.\n" +
      "Run `/vpn connect` on the bot host, or open FortiClient and click Connect.\n" +
      "Active devsync sessions will resume sync once the tunnel is back.\n\n" +
      "🔌 VPN 연결이 끊어진 것 같습니다.\n" +
      "봇 호스트에서 `/vpn connect`를 실행하거나 FortiClient에서 Connect를 클릭하세요.\n" +
      "활성 devsync 세션은 터널 복구 후 자동으로 동기화를 재개합니다.\n\n" +
      "🔌 VPN 似乎已斷線。\n" +
      "請在 bot 主機上執行 `/vpn connect`,或開啟 FortiClient 點擊 Connect。\n" +
      "活躍的 devsync session 會在 tunnel 恢復後自動繼續同步。"
    );
  }
  if (reason === "script_missing") {
    return (
      "🔌 VPN keep-alive cannot run: `~/bin/vpn-status.sh` not found.\n" +
      "Either disable the feature (`VPN_KEEPALIVE_ENABLED=false`) or install the script.\n\n" +
      "🔌 VPN keep-alive을 실행할 수 없습니다: `~/bin/vpn-status.sh`을 찾을 수 없습니다.\n" +
      "기능을 비활성화(`VPN_KEEPALIVE_ENABLED=false`)하거나 스크립트를 설치하세요.\n\n" +
      "🔌 VPN keep-alive 無法執行:找不到 `~/bin/vpn-status.sh`。\n" +
      "請停用此功能(`VPN_KEEPALIVE_ENABLED=false`)或安裝該腳本。"
    );
  }
  // reason === "script_error"
  return (
    "🔌 VPN keep-alive cannot determine status: `~/bin/vpn-status.sh` failed unexpectedly.\n" +
    "Check the bot log for details.\n\n" +
    "🔌 VPN keep-alive이 상태를 확인할 수 없습니다: `~/bin/vpn-status.sh`이 예상치 못한 오류를 발생시켰습니다.\n" +
    "자세한 내용은 봇 로그를 확인하세요.\n\n" +
    "🔌 VPN keep-alive 無法判斷狀態:`~/bin/vpn-status.sh` 發生未預期的錯誤。\n" +
    "請查看 bot log 取得詳情。"
  );
}
```

- [ ] **Step 5: Run all keepalive tests, verify they pass**

Run: `npx vitest run src/vpn/keepalive.test.ts`
Expected: ALL tests pass (5 lifecycle + 6 status + ~9 tick body).

- [ ] **Step 6: Run full project test suite to catch regressions**

Run: `npm test`
Expected: every test in the project passes.

- [ ] **Step 7: Type check**

Run: `npx tsc --noEmit`
Expected: clean exit.

- [ ] **Step 8: Commit**

```bash
git add src/vpn/keepalive.ts src/vpn/keepalive.test.ts
git commit -m "$(cat <<'EOF'
feat(vpn-keepalive): tick body — parallel pings on UP, claim-first DM on DOWN

Tick dispatches on the VpnStatus discriminant:
- connected:true → spawn parallel ICMP pings against every
  configured server from readServerNames(); fire-and-forget
- connected:false → claim-first DM to ALLOWED_USER_IDS[0] with
  reason-specific bilingual+zh-TW message; suppressed on repeat
  until VPN recovery (NOT on script_error/script_missing — those
  configuration-class issues persist and re-DMing would be spam)
- empty server list when VPN up → log once per process

DM payload variants embed EN + KR + zh-TW for `down`,
`script_missing`, and `script_error`. The DM text is inline in
the module — it does NOT extend L(), keeping the i18n infra
untouched.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Wire `startVpnKeepalive` into `src/index.ts`

**Files:**
- Modify: `src/index.ts`

Capture the client from `startBot()` (already done for credentials-heartbeat), call `startVpnKeepalive` after `startCredentialsHeartbeat`, add `stopVpnKeepalive()` to both signal handlers.

- [ ] **Step 1: Add the import**

Edit `src/index.ts`. Add this import block just below the existing credentials-heartbeat import (after line 11):

```typescript
import { startVpnKeepalive, stopVpnKeepalive } from "./vpn/keepalive.js";
```

- [ ] **Step 2: Add `stopVpnKeepalive()` to both signal handlers**

Find this existing block (lines 52-63):

```typescript
  process.on("SIGINT", () => {
    stopCredentialsHeartbeat();
    stopWakeupWatcher().catch(() => {});
    releaseLock();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    stopCredentialsHeartbeat();
    stopWakeupWatcher().catch(() => {});
    releaseLock();
    process.exit(0);
  });
```

Replace with:

```typescript
  process.on("SIGINT", () => {
    stopCredentialsHeartbeat();
    stopVpnKeepalive();
    stopWakeupWatcher().catch(() => {});
    releaseLock();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    stopCredentialsHeartbeat();
    stopVpnKeepalive();
    stopWakeupWatcher().catch(() => {});
    releaseLock();
    process.exit(0);
  });
```

- [ ] **Step 3: Start the keepalive after the credentials heartbeat**

Find this existing block (lines 89-95):

```typescript
  // Start Discord bot
  const client = await startBot();
  startCredentialsHeartbeat(client);
  console.log("Credentials heartbeat started");
  await startWakeupWatcher();
  console.log("Wake-up watcher started");
  console.log("Bot is running!");
```

Replace with:

```typescript
  // Start Discord bot
  const client = await startBot();
  startCredentialsHeartbeat(client);
  console.log("Credentials heartbeat started");
  startVpnKeepalive(client);
  console.log("VPN keep-alive started");
  await startWakeupWatcher();
  console.log("Wake-up watcher started");
  console.log("Bot is running!");
```

- [ ] **Step 4: Type check**

Run: `npx tsc --noEmit`
Expected: clean exit.

- [ ] **Step 5: Run full project test suite**

Run: `npm test`
Expected: every test passes.

- [ ] **Step 6: Build the production bundle**

Run: `npm run build`
Expected: clean ESM bundle. The keep-alive module should be inlined.

- [ ] **Step 7: Verify the keep-alive module is reachable from the entrypoint**

Run: `grep -c "vpn-keepalive" dist/index.js`
Expected: at least 1 match (the bundler inlined the module's log prefix).

- [ ] **Step 8: Commit**

```bash
git add src/index.ts
git commit -m "$(cat <<'EOF'
feat(index): wire VPN keep-alive into bot lifecycle

Starts the VPN keep-alive after startCredentialsHeartbeat and
stops it in both SIGINT and SIGTERM handlers alongside the
existing stop calls. No effect at startup unless
VPN_KEEPALIVE_ENABLED=true in .env (default false) — the
module's own guards keep it inert otherwise.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Manual smoke test instructions

**Files:**
- Modify: `docs/TESTING.md`
- Modify: `docs/TESTING.kr.md`

Append a "VPN Keep-Alive (macOS only, opt-in)" section to both docs.

- [ ] **Step 1: Append the smoke test section to `docs/TESTING.md`**

Append to the end of `docs/TESTING.md`:

```markdown

## VPN Keep-Alive (macOS only, opt-in)

The bot periodically pings the dev servers from
`~/.config/devsync/config.toml` to keep the FortiClient VPN tunnel
hot, and DMs the first `ALLOWED_USER_IDS` entry if the VPN status
detection reports the tunnel is down. The feature is OFF by
default; enable with `VPN_KEEPALIVE_ENABLED=true` in `.env`.

Prerequisites for this smoke test:
- macOS
- FortiClient VPN installed
- `~/bin/vpn-status.sh` present (the leric-style detector)
- `~/.config/devsync/config.toml` with at least one `[servers.*]`
- A Discord bot with `ALLOWED_USER_IDS[0]` set to a user whose
  DMs the bot can reach

### Steady-state pinging

1. Set fast-tick overrides in `.env`:
   ```
   VPN_KEEPALIVE_ENABLED=true
   VPN_KEEPALIVE_INTERVAL_SEC=15
   ```
2. Connect VPN (`/vpn connect`, or click FortiClient).
3. In another terminal, sniff ICMP on the tunnel interface (replace
   `utun4` with whatever `vpn-status.sh` reports):
   ```bash
   sudo tcpdump -i utun4 icmp
   ```
4. Run `npm run dev`. Within ~15 seconds you should see one ICMP
   echo request per configured server in the tcpdump output, and
   in the bot logs:
   ```
   [vpn-keepalive] VPN up on utun4 (10.x.x.x).
   ```
5. Repeat every interval. No Discord DM arrives.

### Drop notification

1. Disconnect VPN (`/vpn disconnect` or click the FortiClient
   button).
2. Within `VPN_KEEPALIVE_INTERVAL_SEC` seconds, the bot owner
   (first entry in `ALLOWED_USER_IDS`) should receive a Discord DM
   containing all three languages (EN, KR, zh-TW). Bot logs show:
   ```
   [vpn-keepalive] Sent VPN-down DM to first allowed user.
   ```
3. Wait another tick. NO second DM. Bot logs show:
   ```
   [vpn-keepalive] VPN still down, no DM.
   ```
4. Reconnect VPN. Within one tick, bot logs show:
   ```
   [vpn-keepalive] VPN recovered.
   [vpn-keepalive] VPN up on utun4 (10.x.x.x).
   ```
5. Disconnect again. A NEW DM should arrive (the recovery reset
   `notifiedDown`).

### Script missing / opt-in error

1. Temporarily rename the script to simulate misconfiguration:
   ```bash
   mv ~/bin/vpn-status.sh ~/bin/vpn-status.sh.disabled
   ```
2. Restart the bot. Within `VPN_KEEPALIVE_INTERVAL_SEC` seconds, a
   DM arrives with the `script_missing` variant (explicitly
   mentioning `~/bin/vpn-status.sh` and
   `VPN_KEEPALIVE_ENABLED=false`).
3. Restore the script:
   ```bash
   mv ~/bin/vpn-status.sh.disabled ~/bin/vpn-status.sh
   ```

### Cleanup

Restore `.env` to defaults (remove the test overrides or set
`VPN_KEEPALIVE_ENABLED=false`) before returning the bot to normal
use.
```

- [ ] **Step 2: Append the same content to `docs/TESTING.kr.md`, translated**

Read `docs/TESTING.kr.md` first to match the project's Korean tone (see how the credentials-heartbeat smoke test was translated for reference). Then append a Korean version of the section above. Shell commands and config keys stay verbatim; only the prose translates. Match terminology used elsewhere in the project (예: 봇, 호스트, 터널, 동기화).

- [ ] **Step 3: Commit**

```bash
git add docs/TESTING.md docs/TESTING.kr.md
git commit -m "$(cat <<'EOF'
docs(testing): add VPN keep-alive smoke test procedure

Documents the manual macOS verification steps for the three modes
the keep-alive operates in: steady-state pinging, drop notification,
and script-missing variant. Includes a tcpdump one-liner to
confirm ICMP traffic actually reaches the tunnel.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Final Verification

After Task 7 commits, run these checks in order. Any failure → stop and fix before declaring complete.

- [ ] **Type check passes:**
  Run: `npx tsc --noEmit`
  Expected: clean exit.

- [ ] **All tests pass:**
  Run: `npm test`
  Expected: every test file green; no skips, no failures. Specifically `src/vpn/keepalive.test.ts` should show ~20 tests passing.

- [ ] **Production build succeeds:**
  Run: `npm run build`
  Expected: clean ESM bundle in `dist/`.

- [ ] **Keep-alive module is reachable from the entrypoint:**
  Run: `grep -c "vpn-keepalive" dist/index.js`
  Expected: at least 1 match.

- [ ] **Git log shows the expected commit sequence:**
  Run: `git log --oneline HEAD~7..HEAD`
  Expected: 7 commits, one per task, with the messages above.

- [ ] **Manual smoke test on macOS** (if feasible, otherwise defer to user):
  Follow the procedure in `docs/TESTING.md` "VPN Keep-Alive" section. All three scenarios (steady-state, drop notification, script-missing) must work as described.

---

## Out-of-Scope Reminders

These were explicitly deferred in the spec and MUST NOT be added during plan execution:

- ❌ Cross-platform VPN-status detection (Linux / Windows / WSL)
- ❌ Auto-reconnect via cliclick
- ❌ Discord button to trigger reconnect
- ❌ Per-host failure reporting (only binary VPN up/down matters for DMs)
- ❌ TCP / SSH / DNS probe fallbacks (pure ICMP for v1)
- ❌ Hot-reload of `config.toml` (restart bot to pick up server changes)
- ❌ Pre-ping to validate VPN before declaring it up
- ❌ Public open-source deployment by default (stays opt-in via env var)

If you encounter a strong reason to add one of these mid-implementation, stop and surface the question — do not silently expand scope.
