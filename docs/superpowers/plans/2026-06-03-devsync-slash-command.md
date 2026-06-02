# `/devsync` Slash Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 7-subcommand `/devsync` static slash command to claudecode-discord that wraps the local `devsync` CLI, with Discord buttons for the start-conflict and stop-all-confirm flows.

**Architecture:** Three new files. `src/utils/devsync-cli.ts` is the only spot that calls `child_process.spawn('devsync', ...)`. `src/bot/commands/devsync.ts` exposes the SlashCommandBuilder and per-subcommand handlers + autocomplete. `src/bot/handlers/devsync-buttons.ts` handles the 5 button customIds. `client.ts` gets one new import + array entry; `handlers/interaction.ts` gets one early-return for `action === "devsync"`.

**Tech Stack:** TypeScript 5 (strict, ESM with `.js` extensions), discord.js v14, vitest + pytest-style mocking, Node.js `child_process`, Node 20+.

**Spec:** `docs/superpowers/specs/2026-06-03-devsync-slash-command-design.md` (REQ-NNN / CON-NNN / AC-NNN IDs referenced).

**Working directory throughout:** `/Users/leric/Desktop/code/claudecode-discord`

---

## File Map (created/modified)

| File | Action | Tasks |
|---|---|---|
| `src/utils/devsync-cli.ts` | CREATE | Task 1 |
| `src/utils/devsync-cli.test.ts` | CREATE | Task 1 |
| `src/bot/commands/devsync.ts` | CREATE | Tasks 2, 3, 4, 5, 6, 7, 9, 10, 11 |
| `src/bot/commands/devsync.test.ts` | CREATE | Tasks 2, 3, 4, 5, 6, 7, 9, 10, 11 |
| `src/bot/handlers/devsync-buttons.ts` | CREATE | Tasks 5, 7 |
| `src/bot/handlers/devsync-buttons.test.ts` | CREATE | Tasks 5, 7 |
| `src/bot/client.ts` | MODIFY (register command) | Task 2 |
| `src/bot/handlers/interaction.ts` | MODIFY (early-return for `devsync:` buttons) | Task 5 |
| `README.md` | MODIFY (smoke checklist) | Task 12 |

---

## Task 1: `runDevsync` wrapper with unit tests

**Files:**
- Create: `src/utils/devsync-cli.ts`
- Create: `src/utils/devsync-cli.test.ts`

- [ ] **Step 1: Write the failing tests**

`src/utils/devsync-cli.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/utils/devsync-cli.test.ts
```

Expected: `Cannot find module './devsync-cli.js'` (or all tests fail with import error).

- [ ] **Step 3: Implement `src/utils/devsync-cli.ts`**

```typescript
import { spawn } from "node:child_process";

export interface DevsyncResult {
  ok: boolean; // exit code === 0
  code: number; // exit code (-1 on timeout, 127 on ENOENT)
  stdout: string; // ANSI-stripped
  stderr: string; // ANSI-stripped
}

export interface RunDevsyncOptions {
  timeoutMs?: number; // default 30_000
  input?: string; // stdin
}

const ANSI_RE = /\[[0-9;]*[a-zA-Z]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/**
 * Spawn the local `devsync` CLI and capture stdout/stderr.
 * The ONLY place that calls child_process.spawn('devsync', ...) per
 * the spec (REQ-009). All Discord-side code goes through this wrapper.
 */
export async function runDevsync(
  args: string[],
  opts: RunDevsyncOptions = {},
): Promise<DevsyncResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;

  return new Promise<DevsyncResult>((resolve) => {
    const child = spawn("devsync", args, {
      stdio: opts.input ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const settle = (result: DevsyncResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      settle({
        ok: false,
        code: -1,
        stdout: stripAnsi(stdout),
        stderr: stripAnsi(stderr) + `\ndevsync ${args.join(" ")} timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        settle({
          ok: false,
          code: 127,
          stdout: "",
          stderr:
            "devsync CLI not found. Install: uv tool install ~/Desktop/code/devsync",
        });
        return;
      }
      settle({
        ok: false,
        code: 1,
        stdout: stripAnsi(stdout),
        stderr: stripAnsi(stderr) + `\nspawn error: ${err.message}`,
      });
    });

    child.on("close", (code) => {
      const exitCode = code ?? 0;
      settle({
        ok: exitCode === 0,
        code: exitCode,
        stdout: stripAnsi(stdout),
        stderr: stripAnsi(stderr),
      });
    });

    if (opts.input) {
      child.stdin?.write(opts.input);
      child.stdin?.end();
    }
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/utils/devsync-cli.test.ts
```

Expected: 6 tests pass.

- [ ] **Step 5: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/utils/devsync-cli.ts src/utils/devsync-cli.test.ts
git -c user.email=a0919376604@gmail.com -c user.name=leric commit -m "feat(devsync): runDevsync wrapper with ANSI strip + timeout + ENOENT handling"
```

---

## Task 2: SlashCommandBuilder skeleton + `/devsync doctor` + register

**Files:**
- Create: `src/bot/commands/devsync.ts`
- Create: `src/bot/commands/devsync.test.ts`
- Modify: `src/bot/client.ts` (add import + array entry)

- [ ] **Step 1: Write the failing tests**

`src/bot/commands/devsync.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { data, execute } from "./devsync.js";

vi.mock("../../utils/devsync-cli.js", () => ({
  runDevsync: vi.fn(),
}));

import { runDevsync } from "../../utils/devsync-cli.js";

function makeInteraction(subcommand: string, opts: Record<string, string> = {}) {
  return {
    options: {
      getSubcommand: vi.fn(() => subcommand),
      getString: vi.fn((name: string, required?: boolean) => {
        const v = opts[name];
        if (required && !v) throw new Error(`missing ${name}`);
        return v ?? null;
      }),
    },
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    deferred: true,
    replied: false,
  } as any;
}

describe("/devsync data", () => {
  it("declares subcommand 'doctor'", () => {
    const json = (data as any).toJSON();
    expect(json.name).toBe("devsync");
    const subs = json.options.map((o: any) => o.name);
    expect(subs).toContain("doctor");
  });
});

describe("/devsync doctor", () => {
  beforeEach(() => {
    vi.mocked(runDevsync).mockReset();
  });

  it("calls runDevsync(['doctor']) and wraps stdout in a code block", async () => {
    vi.mocked(runDevsync).mockResolvedValue({
      ok: true,
      code: 0,
      stdout: "Mutagen daemon: running\nServers:\n dl01 reachable",
      stderr: "",
    });

    const interaction = makeInteraction("doctor");
    await execute(interaction);

    expect(runDevsync).toHaveBeenCalledWith(["doctor"]);
    const arg = vi.mocked(interaction.editReply).mock.calls[0][0];
    const text = typeof arg === "string" ? arg : (arg.content ?? "");
    expect(text).toContain("Mutagen daemon: running");
    expect(text).toContain("```");
  });

  it("on failure, formats stderr with exit code", async () => {
    vi.mocked(runDevsync).mockResolvedValue({
      ok: false,
      code: 3,
      stdout: "",
      stderr: "some error",
    });

    const interaction = makeInteraction("doctor");
    await execute(interaction);

    const text = vi.mocked(interaction.editReply).mock.calls[0][0];
    const content = typeof text === "string" ? text : (text.content ?? "");
    expect(content).toContain("failed");
    expect(content).toContain("exit 3");
    expect(content).toContain("some error");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/bot/commands/devsync.test.ts
```

Expected: `Cannot find module './devsync.js'`.

- [ ] **Step 3: Implement `src/bot/commands/devsync.ts` (skeleton + doctor only)**

```typescript
import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from "discord.js";
import { runDevsync, type DevsyncResult } from "../../utils/devsync-cli.js";
import { L } from "../../utils/i18n.js";

const MAX_DISCORD_BODY = 1900; // leave room for code-fence overhead

export const data = new SlashCommandBuilder()
  .setName("devsync")
  .setDescription("Control the local devsync CLI (mutagen wrapper)")
  .addSubcommand((sub) =>
    sub.setName("doctor").setDescription("Health-check daemon + servers"),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (sub === "doctor") return handleDoctor(interaction);
  // Future subcommands wired in later tasks.
  await interaction.editReply({
    content: L(`Unknown subcommand: ${sub}`, `알 수 없는 하위 명령: ${sub}`),
  });
}

// ─── Subcommand handlers ───

async function handleDoctor(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const r = await runDevsync(["doctor"]);
  await replyWithResult(interaction, "doctor", r);
}

// ─── Helpers ───

function truncate(text: string): string {
  if (text.length <= MAX_DISCORD_BODY) return text;
  return text.slice(0, MAX_DISCORD_BODY) + "\n... (truncated)";
}

async function replyWithResult(
  interaction: ChatInputCommandInteraction,
  subcommand: string,
  r: DevsyncResult,
): Promise<void> {
  if (r.ok) {
    await interaction.editReply({
      content: `\`\`\`\n${truncate(r.stdout || "(no output)")}\n\`\`\``,
    });
    return;
  }
  const body = truncate(r.stderr || r.stdout || "(no output)");
  let content = `✗ devsync ${subcommand} failed (exit ${r.code})\n\`\`\`\n${body}\n\`\`\``;
  // Hint enrichment is added in Task 11.
  await interaction.editReply({ content });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/bot/commands/devsync.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: Register command in `src/bot/client.ts`**

Add this import in the imports block near the top (alphabetical with existing imports):

```typescript
import * as devsyncCmd from "./commands/devsync.js";
```

Then add `devsyncCmd` to the `commands` array. The current line looks like:

```typescript
const commands = [registerCmd, unregisterCmd, worktreeCmd, statusCmd, stopCmd, autoApproveCmd, sessionsCmd, clearSessionsCmd, lastCmd, queueCmd, usageCmd, pluginsSyncCmd, pluginsListCmd, refreshBoardCmd];
```

Change to:

```typescript
const commands = [registerCmd, unregisterCmd, worktreeCmd, statusCmd, stopCmd, autoApproveCmd, sessionsCmd, clearSessionsCmd, lastCmd, queueCmd, usageCmd, pluginsSyncCmd, pluginsListCmd, refreshBoardCmd, devsyncCmd];
```

- [ ] **Step 6: Type-check the whole project**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Full test run to verify no regressions**

```bash
npm test
```

Expected: all existing tests still pass + 3 new ones.

- [ ] **Step 8: Commit**

```bash
git add src/bot/commands/devsync.ts src/bot/commands/devsync.test.ts src/bot/client.ts
git -c user.email=a0919376604@gmail.com -c user.name=leric commit -m "feat(devsync): /devsync slash command skeleton + doctor subcommand"
```

---

## Task 3: `/devsync ls`

**Files:**
- Modify: `src/bot/commands/devsync.ts` (add `ls` subcommand + handler)
- Modify: `src/bot/commands/devsync.test.ts` (add 2 tests)

- [ ] **Step 1: Append failing tests to `src/bot/commands/devsync.test.ts`**

Append at the bottom of the file:

```typescript
describe("/devsync ls", () => {
  beforeEach(() => {
    vi.mocked(runDevsync).mockReset();
  });

  it("calls runDevsync(['ls']) and wraps output in a code block", async () => {
    vi.mocked(runDevsync).mockResolvedValue({
      ok: true,
      code: 0,
      stdout: "Name   Server\nfoo    dl02",
      stderr: "",
    });

    const interaction = makeInteraction("ls");
    await execute(interaction);

    expect(runDevsync).toHaveBeenCalledWith(["ls"]);
    const text = vi.mocked(interaction.editReply).mock.calls[0][0];
    const content = typeof text === "string" ? text : (text.content ?? "");
    expect(content).toContain("foo    dl02");
  });

  it("passes through the 'No active sessions' message from CLI", async () => {
    vi.mocked(runDevsync).mockResolvedValue({
      ok: true,
      code: 0,
      stdout: "No active sessions.",
      stderr: "",
    });

    const interaction = makeInteraction("ls");
    await execute(interaction);

    const text = vi.mocked(interaction.editReply).mock.calls[0][0];
    const content = typeof text === "string" ? text : (text.content ?? "");
    expect(content).toContain("No active sessions");
  });
});
```

- [ ] **Step 2: Run tests to see them fail**

```bash
npx vitest run src/bot/commands/devsync.test.ts -t "ls"
```

Expected: fails because `getSubcommand()` returns "ls" but the handler dispatches "Unknown subcommand: ls".

- [ ] **Step 3: Update `src/bot/commands/devsync.ts`**

In the `data` SlashCommandBuilder, append after `.addSubcommand` for doctor:

```typescript
  .addSubcommand((sub) =>
    sub.setName("ls").setDescription("List active devsync-managed sync sessions"),
  )
```

In `execute()`, add dispatch:

```typescript
  if (sub === "ls") return handleLs(interaction);
```

Add the handler:

```typescript
async function handleLs(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const r = await runDevsync(["ls"]);
  await replyWithResult(interaction, "ls", r);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/bot/commands/devsync.test.ts
```

Expected: 5 tests pass (3 from Task 2 + 2 new).

- [ ] **Step 5: Type-check + full suite**

```bash
npx tsc --noEmit && npm test
```

Expected: no errors, all tests green.

- [ ] **Step 6: Commit**

```bash
git add src/bot/commands/devsync.ts src/bot/commands/devsync.test.ts
git -c user.email=a0919376604@gmail.com -c user.name=leric commit -m "feat(devsync): add /devsync ls subcommand"
```

---

## Task 4: `/devsync status` and `/devsync flush`

**Files:**
- Modify: `src/bot/commands/devsync.ts`
- Modify: `src/bot/commands/devsync.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `src/bot/commands/devsync.test.ts`:

```typescript
describe("/devsync status", () => {
  beforeEach(() => {
    vi.mocked(runDevsync).mockReset();
  });

  it("calls runDevsync(['status', '<repo>']) with the provided repo", async () => {
    vi.mocked(runDevsync).mockResolvedValue({
      ok: true,
      code: 0,
      stdout: "Status: Watching for changes",
      stderr: "",
    });
    const interaction = makeInteraction("status", { repo: "alpha" });
    await execute(interaction);
    expect(runDevsync).toHaveBeenCalledWith(["status", "alpha"]);
    const text = vi.mocked(interaction.editReply).mock.calls[0][0];
    const content = typeof text === "string" ? text : (text.content ?? "");
    expect(content).toContain("Watching");
  });
});

describe("/devsync flush", () => {
  beforeEach(() => {
    vi.mocked(runDevsync).mockReset();
  });

  it("calls runDevsync(['flush', '<repo>']) and replies with success", async () => {
    vi.mocked(runDevsync).mockResolvedValue({
      ok: true,
      code: 0,
      stdout: "✓ Flushed alpha--dl02.",
      stderr: "",
    });
    const interaction = makeInteraction("flush", { repo: "alpha" });
    await execute(interaction);
    expect(runDevsync).toHaveBeenCalledWith(["flush", "alpha"]);
    const text = vi.mocked(interaction.editReply).mock.calls[0][0];
    const content = typeof text === "string" ? text : (text.content ?? "");
    expect(content).toContain("Flushed");
  });
});
```

- [ ] **Step 2: Run tests to see them fail**

```bash
npx vitest run src/bot/commands/devsync.test.ts -t "status|flush"
```

Expected: fails — "Unknown subcommand: status" / "Unknown subcommand: flush".

- [ ] **Step 3: Update `src/bot/commands/devsync.ts`**

In `data`, append two more subcommands:

```typescript
  .addSubcommand((sub) =>
    sub
      .setName("status")
      .setDescription("Show detailed sync status for a repo")
      .addStringOption((opt) =>
        opt
          .setName("repo")
          .setDescription("Repo name (active session)")
          .setRequired(true)
          .setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("flush")
      .setDescription("Force an immediate sync cycle for a repo")
      .addStringOption((opt) =>
        opt
          .setName("repo")
          .setDescription("Repo name (active session)")
          .setRequired(true)
          .setAutocomplete(true),
      ),
  )
```

In `execute`, dispatch:

```typescript
  if (sub === "status") return handleStatus(interaction);
  if (sub === "flush") return handleFlush(interaction);
```

Add handlers:

```typescript
async function handleStatus(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const repo = interaction.options.getString("repo", true);
  const r = await runDevsync(["status", repo]);
  await replyWithResult(interaction, "status", r);
}

async function handleFlush(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const repo = interaction.options.getString("repo", true);
  const r = await runDevsync(["flush", repo]);
  await replyWithResult(interaction, "flush", r);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/bot/commands/devsync.test.ts
```

Expected: 7 tests pass.

- [ ] **Step 5: Type-check**

```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/bot/commands/devsync.ts src/bot/commands/devsync.test.ts
git -c user.email=a0919376604@gmail.com -c user.name=leric commit -m "feat(devsync): /devsync status and /devsync flush subcommands"
```

---

## Task 5: `/devsync stop`

**Files:**
- Modify: `src/bot/commands/devsync.ts`
- Modify: `src/bot/commands/devsync.test.ts`

- [ ] **Step 1: Append failing test**

Append:

```typescript
describe("/devsync stop", () => {
  beforeEach(() => {
    vi.mocked(runDevsync).mockReset();
  });

  it("calls runDevsync(['stop', '<repo>']) and replies", async () => {
    vi.mocked(runDevsync).mockResolvedValue({
      ok: true,
      code: 0,
      stdout: "✓ Terminated 1 session(s) for repo 'alpha'.",
      stderr: "",
    });
    const interaction = makeInteraction("stop", { repo: "alpha" });
    await execute(interaction);
    expect(runDevsync).toHaveBeenCalledWith(["stop", "alpha"]);
    const text = vi.mocked(interaction.editReply).mock.calls[0][0];
    const content = typeof text === "string" ? text : (text.content ?? "");
    expect(content).toContain("Terminated");
  });
});
```

- [ ] **Step 2: Run tests to see it fail**

```bash
npx vitest run src/bot/commands/devsync.test.ts -t "stop"
```

Expected: fails.

- [ ] **Step 3: Update `src/bot/commands/devsync.ts`**

In `data`, append:

```typescript
  .addSubcommand((sub) =>
    sub
      .setName("stop")
      .setDescription("Terminate the sync session for a repo")
      .addStringOption((opt) =>
        opt
          .setName("repo")
          .setDescription("Repo name (active session)")
          .setRequired(true)
          .setAutocomplete(true),
      ),
  )
```

In `execute`:

```typescript
  if (sub === "stop") return handleStop(interaction);
```

Add handler:

```typescript
async function handleStop(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const repo = interaction.options.getString("repo", true);
  const r = await runDevsync(["stop", repo]);
  await replyWithResult(interaction, "stop", r);
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/bot/commands/devsync.test.ts
```

Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/bot/commands/devsync.ts src/bot/commands/devsync.test.ts
git -c user.email=a0919376604@gmail.com -c user.name=leric commit -m "feat(devsync): /devsync stop subcommand"
```

---

## Task 6: `/devsync stop_all` with confirm button + button-handler scaffold

**Files:**
- Modify: `src/bot/commands/devsync.ts`
- Modify: `src/bot/commands/devsync.test.ts`
- Create: `src/bot/handlers/devsync-buttons.ts`
- Create: `src/bot/handlers/devsync-buttons.test.ts`
- Modify: `src/bot/handlers/interaction.ts` (early-return for `action === "devsync"`)

- [ ] **Step 1: Append failing test for `stop_all`**

Append to `src/bot/commands/devsync.test.ts`:

```typescript
describe("/devsync stop_all", () => {
  beforeEach(() => {
    vi.mocked(runDevsync).mockReset();
  });

  it("with zero sessions replies 'no sessions to terminate' without buttons", async () => {
    vi.mocked(runDevsync).mockResolvedValue({
      ok: true,
      code: 0,
      stdout: "No active sessions.",
      stderr: "",
    });

    const interaction = makeInteraction("stop_all");
    await execute(interaction);

    // Should only check `ls`, never invoke stop --all
    expect(runDevsync).toHaveBeenCalledTimes(1);
    expect(runDevsync).toHaveBeenCalledWith(["ls"]);
    const arg = vi.mocked(interaction.editReply).mock.calls[0][0];
    const content =
      typeof arg === "string" ? arg : (arg.content ?? JSON.stringify(arg));
    expect(content.toLowerCase()).toContain("no sessions");
  });

  it("with N>0 sessions replies with Confirm/Cancel buttons", async () => {
    vi.mocked(runDevsync).mockResolvedValue({
      ok: true,
      code: 0,
      // Mimic the CLI: header line + 2 entries
      stdout:
        "Name             Server\nalpha--dl01      dl01\nbeta--dl02       dl02",
      stderr: "",
    });

    const interaction = makeInteraction("stop_all");
    await execute(interaction);

    // Did not call stop --all yet; only ls
    expect(runDevsync).toHaveBeenCalledTimes(1);
    expect(runDevsync).toHaveBeenCalledWith(["ls"]);

    const arg = vi.mocked(interaction.editReply).mock.calls[0][0] as any;
    expect(arg.components).toBeDefined();
    expect(arg.components.length).toBeGreaterThan(0);
    const labels = arg.components[0].components.map((c: any) => c.data.label);
    expect(labels.some((l: string) => /confirm/i.test(l))).toBe(true);
    expect(labels.some((l: string) => /cancel/i.test(l))).toBe(true);
    const customIds = arg.components[0].components.map(
      (c: any) => c.data.custom_id,
    );
    expect(customIds).toContain("devsync:stop_all:confirm");
    expect(customIds).toContain("devsync:stop_all:cancel");
  });
});
```

- [ ] **Step 2: Run tests to see them fail**

```bash
npx vitest run src/bot/commands/devsync.test.ts -t "stop_all"
```

Expected: fails — "Unknown subcommand: stop_all".

- [ ] **Step 3: Update `src/bot/commands/devsync.ts`**

Add imports at top:

```typescript
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
```

In `data`, append:

```typescript
  .addSubcommand((sub) =>
    sub
      .setName("stop_all")
      .setDescription("Terminate every devsync-managed sync session"),
  )
```

In `execute`:

```typescript
  if (sub === "stop_all") return handleStopAll(interaction);
```

Add a session-counting helper and the handler:

```typescript
/**
 * Parse `devsync ls` stdout and return the number of active sessions.
 * The CLI emits a Rich table; we count data lines by detecting "--" in the
 * session-name column. Fallback: if output contains "No active sessions", return 0.
 */
export function countSessionsInLs(stdout: string): number {
  if (/no active sessions/i.test(stdout)) return 0;
  const lines = stdout.split("\n");
  let count = 0;
  for (const line of lines) {
    // Session names are <repo>--<server>; the table will contain that pattern
    // in the Name column. Skip header / separator lines.
    if (/^\s*\S+--\S+/.test(line)) count += 1;
  }
  return count;
}

async function handleStopAll(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const ls = await runDevsync(["ls"]);
  if (!ls.ok) {
    await replyWithResult(interaction, "stop_all", ls);
    return;
  }
  const n = countSessionsInLs(ls.stdout);
  if (n === 0) {
    await interaction.editReply({
      content: L("(no sessions to terminate)", "(중지할 세션이 없습니다)"),
    });
    return;
  }
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("devsync:stop_all:confirm")
      .setLabel(L(`Confirm — terminate ${n} session(s)`, `확인 — ${n}개 세션 종료`))
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("devsync:stop_all:cancel")
      .setLabel(L("Cancel", "취소"))
      .setStyle(ButtonStyle.Secondary),
  );
  await interaction.editReply({
    content: L(
      `⚠️ About to terminate ${n} active devsync session(s).`,
      `⚠️ ${n}개의 devsync 세션을 종료하려고 합니다.`,
    ),
    components: [row],
  });
}
```

- [ ] **Step 4: Create `src/bot/handlers/devsync-buttons.ts`**

```typescript
import { ButtonInteraction } from "discord.js";
import { runDevsync } from "../../utils/devsync-cli.js";
import { L } from "../../utils/i18n.js";

/**
 * Handle Discord button interactions whose customId starts with "devsync:".
 *
 * customId schema:
 *   devsync:start:reuse:<sessionName>
 *   devsync:start:restart:<sessionName>
 *   devsync:start:cancel
 *   devsync:stop_all:confirm
 *   devsync:stop_all:cancel
 *
 * NOTE: client.ts pre-parses the FIRST colon and routes here when
 * action === "devsync"; the raw customId still contains the full string.
 */
export async function handleDevsyncButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const parts = interaction.customId.split(":");
  // parts[0] === "devsync"
  const family = parts[1]; // "start" | "stop_all"
  const action = parts[2]; // "reuse" | "restart" | "cancel" | "confirm"
  const payload = parts.slice(3).join(":"); // e.g., sessionName "alpha--dl02"

  if (family === "stop_all" && action === "confirm") {
    await interaction.deferUpdate();
    const r = await runDevsync(["stop", "--all"]);
    await interaction.editReply({
      content: r.ok
        ? L(`✓ ${r.stdout.trim() || "All sessions terminated."}`, `✓ 모든 세션이 종료되었습니다.`)
        : L(`✗ stop --all failed (exit ${r.code})\n\`\`\`\n${r.stderr || r.stdout}\n\`\`\``,
            `✗ stop --all 실패 (exit ${r.code})\n\`\`\`\n${r.stderr || r.stdout}\n\`\`\``),
      components: [],
    });
    return;
  }
  if (family === "stop_all" && action === "cancel") {
    await interaction.deferUpdate();
    await interaction.editReply({
      content: L("Cancelled.", "취소되었습니다."),
      components: [],
    });
    return;
  }
  // start:* buttons wired in Task 7.
  if (family === "start") {
    // Placeholder until Task 7
    await interaction.deferUpdate();
    await interaction.editReply({
      content: L("Start button handler not yet implemented.", "Start 버튼 핸들러 미구현."),
      components: [],
    });
    // Reference unused payload var so TS strict noUnusedLocals is happy
    void payload;
    return;
  }
  // Unknown — log and silently swallow (the dispatcher already filtered prefix).
  console.warn(`[devsync-buttons] unknown customId: ${interaction.customId}`);
  if (!interaction.replied && !interaction.deferred) {
    await interaction.deferUpdate();
  }
}
```

- [ ] **Step 5: Create `src/bot/handlers/devsync-buttons.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleDevsyncButton } from "./devsync-buttons.js";

vi.mock("../../utils/devsync-cli.js", () => ({
  runDevsync: vi.fn(),
}));

import { runDevsync } from "../../utils/devsync-cli.js";

function makeButton(customId: string) {
  return {
    customId,
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    replied: false,
    deferred: false,
  } as any;
}

describe("handleDevsyncButton", () => {
  beforeEach(() => vi.mocked(runDevsync).mockReset());

  it("stop_all:confirm calls runDevsync(['stop', '--all'])", async () => {
    vi.mocked(runDevsync).mockResolvedValue({
      ok: true,
      code: 0,
      stdout: "✓ Terminated 3 session(s).",
      stderr: "",
    });
    const i = makeButton("devsync:stop_all:confirm");
    await handleDevsyncButton(i);
    expect(runDevsync).toHaveBeenCalledWith(["stop", "--all"]);
    expect(i.editReply).toHaveBeenCalled();
    const arg = vi.mocked(i.editReply).mock.calls[0][0];
    expect(arg.components).toEqual([]);
  });

  it("stop_all:cancel does not call runDevsync", async () => {
    const i = makeButton("devsync:stop_all:cancel");
    await handleDevsyncButton(i);
    expect(runDevsync).not.toHaveBeenCalled();
    const arg = vi.mocked(i.editReply).mock.calls[0][0];
    expect(arg.content).toMatch(/cancel/i);
    expect(arg.components).toEqual([]);
  });

  it("stop_all:confirm propagates failure with exit code", async () => {
    vi.mocked(runDevsync).mockResolvedValue({
      ok: false,
      code: 1,
      stdout: "",
      stderr: "daemon down",
    });
    const i = makeButton("devsync:stop_all:confirm");
    await handleDevsyncButton(i);
    const arg = vi.mocked(i.editReply).mock.calls[0][0];
    expect(arg.content).toMatch(/exit 1/);
    expect(arg.content).toMatch(/daemon down/);
  });
});
```

- [ ] **Step 6: Wire `devsync-buttons.ts` into `src/bot/handlers/interaction.ts`**

Open `src/bot/handlers/interaction.ts`. Find this block near the top of `handleButtonInteraction`:

```typescript
  const customId = interaction.customId;
  // Use split with limit to handle session IDs that might contain colons
  const colonIndex = customId.indexOf(":");
  const action = colonIndex === -1 ? customId : customId.slice(0, colonIndex);
  const requestId = colonIndex === -1 ? "" : customId.slice(colonIndex + 1);

  if (!requestId) {
    await interaction.reply({
      content: L("Invalid button interaction.", "잘못된 버튼 상호작용입니다."),
      ephemeral: true,
    });
    return;
  }
```

After this block (before `if (action === "stop")`), insert:

```typescript
  // Devsync buttons (handled by dedicated module). Delegate before the
  // existing handlers so customIds prefixed with "devsync:" never fall
  // through to the legacy action-name branches.
  if (action === "devsync") {
    const { handleDevsyncButton } = await import("./devsync-buttons.js");
    await handleDevsyncButton(interaction);
    return;
  }
```

- [ ] **Step 7: Run tests + type-check + full suite**

```bash
npx vitest run src/bot/commands/devsync.test.ts src/bot/handlers/devsync-buttons.test.ts
npx tsc --noEmit
npm test
```

Expected: all green, 13+ devsync-related tests + existing suite passes.

- [ ] **Step 8: Commit**

```bash
git add src/bot/commands/devsync.ts src/bot/commands/devsync.test.ts \
        src/bot/handlers/devsync-buttons.ts src/bot/handlers/devsync-buttons.test.ts \
        src/bot/handlers/interaction.ts
git -c user.email=a0919376604@gmail.com -c user.name=leric commit -m "feat(devsync): /devsync stop_all with confirm button + button-handler scaffold"
```

---

## Task 7: `/devsync start` (no-conflict path) and conflict-detection with 3 buttons

**Files:**
- Modify: `src/bot/commands/devsync.ts`
- Modify: `src/bot/commands/devsync.test.ts`
- Modify: `src/bot/handlers/devsync-buttons.ts` (implement start:reuse / start:restart / start:cancel)
- Modify: `src/bot/handlers/devsync-buttons.test.ts`

- [ ] **Step 1: Append failing tests in `devsync.test.ts`**

```typescript
describe("/devsync start", () => {
  beforeEach(() => {
    vi.mocked(runDevsync).mockReset();
  });

  it("with no existing session, spawns devsync start with --no-ssh", async () => {
    // First call: ls (no match) → empty list output
    vi.mocked(runDevsync).mockResolvedValueOnce({
      ok: true,
      code: 0,
      stdout: "No active sessions.",
      stderr: "",
    });
    // Second call: actual start
    vi.mocked(runDevsync).mockResolvedValueOnce({
      ok: true,
      code: 0,
      stdout: "→ Sync session created: foo--dl02",
      stderr: "",
    });

    const interaction = makeInteraction("start", { repo: "foo", server: "dl02" });
    await execute(interaction);

    expect(runDevsync).toHaveBeenCalledTimes(2);
    expect(runDevsync.mock.calls[0][0]).toEqual(["ls"]);
    expect(runDevsync.mock.calls[1][0]).toEqual(["start", "foo", "dl02", "--no-ssh"]);

    const text = vi.mocked(interaction.editReply).mock.calls[0][0];
    const content = typeof text === "string" ? text : (text.content ?? "");
    expect(content).toContain("Sync session created");
  });

  it("with existing session, replies with 3 buttons (Reuse/Restart/Cancel)", async () => {
    vi.mocked(runDevsync).mockResolvedValueOnce({
      ok: true,
      code: 0,
      stdout:
        "Name             Server\nfoo--dl02        dl02",
      stderr: "",
    });

    const interaction = makeInteraction("start", { repo: "foo", server: "dl02" });
    await execute(interaction);

    // Did not spawn start; only ls
    expect(runDevsync).toHaveBeenCalledTimes(1);

    const arg = vi.mocked(interaction.editReply).mock.calls[0][0] as any;
    expect(arg.components).toBeDefined();
    const customIds = arg.components[0].components.map((c: any) => c.data.custom_id);
    expect(customIds).toContain("devsync:start:reuse:foo--dl02");
    expect(customIds).toContain("devsync:start:restart:foo--dl02");
    expect(customIds).toContain("devsync:start:cancel");
  });

  it("falls back to buttons when start fails with 'already exists' race", async () => {
    vi.mocked(runDevsync).mockResolvedValueOnce({
      ok: true, code: 0, stdout: "No active sessions.", stderr: "",
    });
    vi.mocked(runDevsync).mockResolvedValueOnce({
      ok: false, code: 1, stdout: "",
      stderr: "Mutagen session 'foo--dl02' already exists.",
    });

    const interaction = makeInteraction("start", { repo: "foo", server: "dl02" });
    await execute(interaction);

    const arg = vi.mocked(interaction.editReply).mock.calls[0][0] as any;
    // Should NOT just print the failure — should show 3 buttons.
    expect(arg.components).toBeDefined();
    const customIds = arg.components[0].components.map((c: any) => c.data.custom_id);
    expect(customIds).toContain("devsync:start:reuse:foo--dl02");
  });
});
```

- [ ] **Step 2: Run tests to see them fail**

```bash
npx vitest run src/bot/commands/devsync.test.ts -t "start"
```

Expected: fails — "Unknown subcommand: start".

- [ ] **Step 3: Update `src/bot/commands/devsync.ts`**

In `data`, append:

```typescript
  .addSubcommand((sub) =>
    sub
      .setName("start")
      .setDescription("Start a sync session for <repo> against <server>")
      .addStringOption((opt) =>
        opt
          .setName("repo")
          .setDescription("Repo name under code_root")
          .setRequired(true),
      )
      .addStringOption((opt) =>
        opt
          .setName("server")
          .setDescription("Target server (dl01..dl04)")
          .setRequired(true)
          .setAutocomplete(true),
      ),
  )
```

In `execute`:

```typescript
  if (sub === "start") return handleStart(interaction);
```

Add helper + handler:

```typescript
/**
 * Detect whether `devsync ls` output already contains a session for
 * <repo>--<server>. Looks for that exact prefix at the start of any line.
 */
export function lsHasSession(
  stdout: string,
  repo: string,
  server: string,
): boolean {
  const name = `${repo}--${server}`;
  return stdout.split("\n").some((line) => line.trim().startsWith(name));
}

async function handleStart(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const repo = interaction.options.getString("repo", true);
  const server = interaction.options.getString("server", true);
  const name = `${repo}--${server}`;

  const ls = await runDevsync(["ls"]);
  if (!ls.ok) {
    await replyWithResult(interaction, "start", ls);
    return;
  }

  if (lsHasSession(ls.stdout, repo, server)) {
    await replyWithConflictButtons(interaction, name);
    return;
  }

  const create = await runDevsync(["start", repo, server, "--no-ssh"]);
  if (!create.ok && /already exists/i.test(create.stderr + create.stdout)) {
    // Race: between ls and start, someone else created it. Fall back to buttons.
    await replyWithConflictButtons(interaction, name);
    return;
  }
  await replyWithResult(interaction, "start", create);
}

async function replyWithConflictButtons(
  interaction: ChatInputCommandInteraction,
  sessionName: string,
): Promise<void> {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`devsync:start:reuse:${sessionName}`)
      .setLabel(L("Reuse", "재사용"))
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`devsync:start:restart:${sessionName}`)
      .setLabel(L("Restart", "재시작"))
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("devsync:start:cancel")
      .setLabel(L("Cancel", "취소"))
      .setStyle(ButtonStyle.Secondary),
  );
  await interaction.editReply({
    content: L(
      `ⓘ Session \`${sessionName}\` already exists.`,
      `ⓘ \`${sessionName}\` 세션이 이미 존재합니다.`,
    ),
    components: [row],
  });
}
```

- [ ] **Step 4: Replace the `start:` placeholder branch in `devsync-buttons.ts`**

Open `src/bot/handlers/devsync-buttons.ts`. Replace the `if (family === "start")` placeholder block (the one with "Start button handler not yet implemented.") with:

```typescript
  if (family === "start") {
    await interaction.deferUpdate();

    if (action === "cancel") {
      await interaction.editReply({
        content: L("Cancelled.", "취소되었습니다."),
        components: [],
      });
      return;
    }

    const sessionName = payload; // <repo>--<server>
    const sepIdx = sessionName.indexOf("--");
    if (sepIdx < 0) {
      await interaction.editReply({
        content: L(
          `Malformed session name in button: ${sessionName}`,
          `버튼에 잘못된 세션 이름: ${sessionName}`,
        ),
        components: [],
      });
      return;
    }
    const repo = sessionName.slice(0, sepIdx);
    const server = sessionName.slice(sepIdx + 2);

    if (action === "reuse") {
      await interaction.editReply({
        content: L(`✓ Reusing session \`${sessionName}\`.`, `✓ \`${sessionName}\` 세션 재사용.`),
        components: [],
      });
      return;
    }

    if (action === "restart") {
      const stop = await runDevsync(["stop", repo]);
      if (!stop.ok) {
        await interaction.editReply({
          content: L(
            `✗ Could not stop existing session (exit ${stop.code}):\n\`\`\`\n${stop.stderr || stop.stdout}\n\`\`\``,
            `✗ 기존 세션 중지 실패 (exit ${stop.code}):\n\`\`\`\n${stop.stderr || stop.stdout}\n\`\`\``,
          ),
          components: [],
        });
        return;
      }
      const create = await runDevsync(["start", repo, server, "--no-ssh"]);
      await interaction.editReply({
        content: create.ok
          ? L(`✓ Restarted \`${sessionName}\`.\n\`\`\`\n${create.stdout.trim() || ""}\n\`\`\``,
              `✓ \`${sessionName}\` 재시작 완료.\n\`\`\`\n${create.stdout.trim() || ""}\n\`\`\``)
          : L(`✗ Restart failed (exit ${create.code}):\n\`\`\`\n${create.stderr || create.stdout}\n\`\`\``,
              `✗ 재시작 실패 (exit ${create.code}):\n\`\`\`\n${create.stderr || create.stdout}\n\`\`\``),
        components: [],
      });
      return;
    }

    // Unknown action under "start" — log and end.
    console.warn(`[devsync-buttons] unknown start action: ${action}`);
    return;
  }
```

(Also remove the now-unused `void payload;` line, since `payload` is now consumed before the start branch returns.)

- [ ] **Step 5: Append failing tests in `devsync-buttons.test.ts`**

```typescript
describe("handleDevsyncButton — start", () => {
  beforeEach(() => vi.mocked(runDevsync).mockReset());

  it("start:reuse:<name> replies 'Reusing' and does NOT call runDevsync", async () => {
    const i = makeButton("devsync:start:reuse:foo--dl02");
    await handleDevsyncButton(i);
    expect(runDevsync).not.toHaveBeenCalled();
    const arg = vi.mocked(i.editReply).mock.calls[0][0];
    expect(arg.content).toMatch(/reusing/i);
    expect(arg.components).toEqual([]);
  });

  it("start:cancel replies 'Cancelled' and does NOT call runDevsync", async () => {
    const i = makeButton("devsync:start:cancel");
    await handleDevsyncButton(i);
    expect(runDevsync).not.toHaveBeenCalled();
    const arg = vi.mocked(i.editReply).mock.calls[0][0];
    expect(arg.content).toMatch(/cancel/i);
  });

  it("start:restart:<name> stops then starts in order", async () => {
    vi.mocked(runDevsync).mockResolvedValueOnce({
      ok: true, code: 0, stdout: "stopped", stderr: "",
    });
    vi.mocked(runDevsync).mockResolvedValueOnce({
      ok: true, code: 0, stdout: "→ Sync session created: foo--dl02", stderr: "",
    });
    const i = makeButton("devsync:start:restart:foo--dl02");
    await handleDevsyncButton(i);
    expect(runDevsync).toHaveBeenCalledTimes(2);
    expect(runDevsync.mock.calls[0][0]).toEqual(["stop", "foo"]);
    expect(runDevsync.mock.calls[1][0]).toEqual(["start", "foo", "dl02", "--no-ssh"]);
    const arg = vi.mocked(i.editReply).mock.calls[0][0];
    expect(arg.content).toMatch(/restarted/i);
  });

  it("start:restart:<name> propagates failure if stop fails (does not call start)", async () => {
    vi.mocked(runDevsync).mockResolvedValueOnce({
      ok: false, code: 1, stdout: "", stderr: "daemon down",
    });
    const i = makeButton("devsync:start:restart:foo--dl02");
    await handleDevsyncButton(i);
    expect(runDevsync).toHaveBeenCalledTimes(1); // only stop, no start
    const arg = vi.mocked(i.editReply).mock.calls[0][0];
    expect(arg.content).toMatch(/could not stop/i);
  });
});
```

- [ ] **Step 6: Run tests + type-check + full suite**

```bash
npx vitest run src/bot/commands/devsync.test.ts src/bot/handlers/devsync-buttons.test.ts
npx tsc --noEmit
npm test
```

Expected: all green; devsync test count grows to ~17.

- [ ] **Step 7: Commit**

```bash
git add src/bot/commands/devsync.ts src/bot/commands/devsync.test.ts \
        src/bot/handlers/devsync-buttons.ts src/bot/handlers/devsync-buttons.test.ts
git -c user.email=a0919376604@gmail.com -c user.name=leric commit -m "feat(devsync): /devsync start + reuse/restart/cancel button flow"
```

---

## Task 8: `<server>` autocomplete (read config.toml)

**Files:**
- Modify: `src/bot/commands/devsync.ts` (add `autocomplete` export)
- Modify: `src/bot/commands/devsync.test.ts`

- [ ] **Step 1: Append failing test**

Append to `src/bot/commands/devsync.test.ts`:

```typescript
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { autocomplete } from "./devsync.js";

function makeAutocomplete(subcommand: string, optionName: string, focused: string) {
  return {
    options: {
      getSubcommand: vi.fn(() => subcommand),
      getFocused: vi.fn(() => ({ name: optionName, value: focused })),
    },
    respond: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe("/devsync autocomplete — server", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns keys of [servers.*] from config.toml", async () => {
    vi.spyOn(os, "homedir").mockReturnValue("/fake/home");
    vi.spyOn(fs, "readFileSync").mockImplementation((p) => {
      if (String(p).endsWith("/.config/devsync/config.toml")) {
        return [
          "[defaults]",
          'code_root = "/x"',
          'remote_base = "/y"',
          "",
          "[servers.dl01]",
          'host = "dl01"',
          "",
          "[servers.dl02]",
          'host = "dl02"',
          "",
          "[servers.dl03]",
          'host = "dl03"',
        ].join("\n");
      }
      throw new Error("unexpected path: " + p);
    });

    const i = makeAutocomplete("start", "server", "");
    await autocomplete(i);
    expect(i.respond).toHaveBeenCalled();
    const choices = vi.mocked(i.respond).mock.calls[0][0];
    const names = choices.map((c: any) => c.name);
    expect(names).toEqual(expect.arrayContaining(["dl01", "dl02", "dl03"]));
  });

  it("filters by focused prefix", async () => {
    vi.spyOn(os, "homedir").mockReturnValue("/fake/home");
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      ["[servers.dl01]", "host = \"dl01\"", "", "[servers.dl02]", "host = \"dl02\"", "", "[servers.gpu1]", "host = \"gpu1\""].join("\n"),
    );
    const i = makeAutocomplete("start", "server", "dl");
    await autocomplete(i);
    const names = vi.mocked(i.respond).mock.calls[0][0].map((c: any) => c.name);
    expect(names).toEqual(expect.arrayContaining(["dl01", "dl02"]));
    expect(names).not.toContain("gpu1");
  });

  it("returns empty array if config.toml is missing", async () => {
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      const e: NodeJS.ErrnoException = new Error("ENOENT");
      e.code = "ENOENT";
      throw e;
    });
    const i = makeAutocomplete("start", "server", "");
    await autocomplete(i);
    expect(i.respond).toHaveBeenCalledWith([]);
  });
});
```

- [ ] **Step 2: Run test to see it fail**

```bash
npx vitest run src/bot/commands/devsync.test.ts -t "autocomplete"
```

Expected: fails — `autocomplete` not exported.

- [ ] **Step 3: Add `autocomplete` export to `src/bot/commands/devsync.ts`**

Add imports at top:

```typescript
import { AutocompleteInteraction } from "discord.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
```

Add helper + export:

```typescript
/**
 * Parse the `[servers.*]` table headers from `~/.config/devsync/config.toml`
 * and return the server names. Tolerates missing file (returns []) and
 * malformed TOML (best-effort substring match — autocomplete is non-critical).
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

export async function autocomplete(
  interaction: AutocompleteInteraction,
): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name === "server") {
    const all = readServerNames();
    const filtered = all
      .filter((n) => n.startsWith(String(focused.value || "")))
      .slice(0, 25)
      .map((n) => ({ name: n, value: n }));
    await interaction.respond(filtered);
    return;
  }
  // <repo> autocomplete handled in Task 9
  await interaction.respond([]);
}
```

- [ ] **Step 4: Run tests + type-check**

```bash
npx vitest run src/bot/commands/devsync.test.ts -t "autocomplete"
npx tsc --noEmit
```

Expected: 3 new tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/bot/commands/devsync.ts src/bot/commands/devsync.test.ts
git -c user.email=a0919376604@gmail.com -c user.name=leric commit -m "feat(devsync): autocomplete server from ~/.config/devsync/config.toml"
```

---

## Task 9: `<repo>` autocomplete (from `devsync ls`)

**Files:**
- Modify: `src/bot/commands/devsync.ts`
- Modify: `src/bot/commands/devsync.test.ts`

- [ ] **Step 1: Append failing test**

Append:

```typescript
describe("/devsync autocomplete — repo", () => {
  beforeEach(() => vi.mocked(runDevsync).mockReset());

  it("returns distinct repo names extracted from `devsync ls` output", async () => {
    vi.mocked(runDevsync).mockResolvedValue({
      ok: true,
      code: 0,
      stdout: [
        "Name             Server",
        "alpha--dl01      dl01",
        "alpha--dl02      dl02",
        "beta--dl01       dl01",
      ].join("\n"),
      stderr: "",
    });

    const i = makeAutocomplete("stop", "repo", "");
    await autocomplete(i);
    const names = vi.mocked(i.respond).mock.calls[0][0].map((c: any) => c.name);
    expect(names).toEqual(expect.arrayContaining(["alpha", "beta"]));
    // De-duped: 'alpha' should appear once
    expect(names.filter((n: string) => n === "alpha").length).toBe(1);
  });

  it("filters by focused prefix", async () => {
    vi.mocked(runDevsync).mockResolvedValue({
      ok: true,
      code: 0,
      stdout: ["alpha--dl01", "beta--dl02", "gamma--dl03"].join("\n"),
      stderr: "",
    });
    const i = makeAutocomplete("stop", "repo", "b");
    await autocomplete(i);
    const names = vi.mocked(i.respond).mock.calls[0][0].map((c: any) => c.name);
    expect(names).toEqual(["beta"]);
  });

  it("returns empty when ls fails or no sessions", async () => {
    vi.mocked(runDevsync).mockResolvedValue({
      ok: true,
      code: 0,
      stdout: "No active sessions.",
      stderr: "",
    });
    const i = makeAutocomplete("stop", "repo", "");
    await autocomplete(i);
    expect(i.respond).toHaveBeenCalledWith([]);
  });
});
```

- [ ] **Step 2: Run test to see it fail**

```bash
npx vitest run src/bot/commands/devsync.test.ts -t "autocomplete — repo"
```

Expected: fails — repo autocomplete returns `[]`.

- [ ] **Step 3: Update `src/bot/commands/devsync.ts`**

Add helper above `autocomplete`:

```typescript
/**
 * Extract distinct repo names from the names column of `devsync ls` output.
 * Session names follow the <repo>--<server> convention (REQ-011 of devsync spec).
 */
export function reposFromLs(stdout: string): string[] {
  const set = new Set<string>();
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    const m = line.match(/^([A-Za-z0-9._-]+)--[A-Za-z0-9._-]+/);
    if (m) set.add(m[1]);
  }
  return [...set];
}
```

Replace the placeholder `await interaction.respond([])` at the end of `autocomplete` with:

```typescript
  if (focused.name === "repo") {
    const ls = await runDevsync(["ls"]);
    if (!ls.ok) {
      await interaction.respond([]);
      return;
    }
    const all = reposFromLs(ls.stdout);
    const filtered = all
      .filter((n) => n.startsWith(String(focused.value || "")))
      .slice(0, 25)
      .map((n) => ({ name: n, value: n }));
    await interaction.respond(filtered);
    return;
  }
  await interaction.respond([]);
```

- [ ] **Step 4: Run tests + full suite**

```bash
npx vitest run src/bot/commands/devsync.test.ts -t "autocomplete"
npm test
```

Expected: 6 autocomplete tests pass; full suite still green.

- [ ] **Step 5: Commit**

```bash
git add src/bot/commands/devsync.ts src/bot/commands/devsync.test.ts
git -c user.email=a0919376604@gmail.com -c user.name=leric commit -m "feat(devsync): autocomplete repo from devsync ls output"
```

---

## Task 10: Error hint enrichment (install hint + VPN hint + truncation)

**Files:**
- Modify: `src/bot/commands/devsync.ts` (enrich `replyWithResult`)
- Modify: `src/bot/commands/devsync.test.ts`

- [ ] **Step 1: Append failing tests**

Append:

```typescript
describe("/devsync error enrichment", () => {
  beforeEach(() => vi.mocked(runDevsync).mockReset());

  it("appends install hint when exit code is 127 (ENOENT)", async () => {
    vi.mocked(runDevsync).mockResolvedValue({
      ok: false,
      code: 127,
      stdout: "",
      stderr: "devsync CLI not found. Install: uv tool install ~/Desktop/code/devsync",
    });
    const interaction = makeInteraction("doctor");
    await execute(interaction);
    const content = vi.mocked(interaction.editReply).mock.calls[0][0].content;
    expect(content).toMatch(/uv tool install/);
  });

  it("appends VPN hint when stderr mentions 'Cannot reach server'", async () => {
    vi.mocked(runDevsync).mockResolvedValue({
      ok: false,
      code: 3,
      stdout: "",
      stderr: "Cannot reach server 'dl02' (192.168.90.32): timeout",
    });
    const interaction = makeInteraction("doctor");
    await execute(interaction);
    const content = vi.mocked(interaction.editReply).mock.calls[0][0].content;
    expect(content).toMatch(/VPN/i);
  });

  it("truncates output longer than 1900 chars", async () => {
    const long = "x".repeat(3000);
    vi.mocked(runDevsync).mockResolvedValue({
      ok: true,
      code: 0,
      stdout: long,
      stderr: "",
    });
    const interaction = makeInteraction("doctor");
    await execute(interaction);
    const content = vi.mocked(interaction.editReply).mock.calls[0][0].content;
    expect(content).toMatch(/\(truncated\)/);
    expect(content.length).toBeLessThan(2000);
  });
});
```

- [ ] **Step 2: Run tests to see them fail**

```bash
npx vitest run src/bot/commands/devsync.test.ts -t "error enrichment"
```

Expected: install-hint and VPN-hint tests fail (currently no enrichment). Truncation should already pass from Task 2's helper.

- [ ] **Step 3: Update `replyWithResult` in `src/bot/commands/devsync.ts`**

Replace the existing `replyWithResult` function with:

```typescript
async function replyWithResult(
  interaction: ChatInputCommandInteraction,
  subcommand: string,
  r: DevsyncResult,
): Promise<void> {
  if (r.ok) {
    await interaction.editReply({
      content: `\`\`\`\n${truncate(r.stdout || "(no output)")}\n\`\`\``,
    });
    return;
  }
  const body = truncate(r.stderr || r.stdout || "(no output)");
  let content = `✗ devsync ${subcommand} failed (exit ${r.code})\n\`\`\`\n${body}\n\`\`\``;

  // Hint enrichment
  const stderrLower = r.stderr.toLowerCase();
  if (r.code === 127) {
    content += L(
      `\nInstall: \`uv tool install ~/Desktop/code/devsync\``,
      `\n설치: \`uv tool install ~/Desktop/code/devsync\``,
    );
  } else if (
    stderrLower.includes("cannot reach server") ||
    stderrLower.includes("connection timed out") ||
    stderrLower.includes("operation timed out")
  ) {
    content += L(
      `\nCheck VPN: run \`/vpn status\` on the bot host.`,
      `\nVPN 확인: bot 호스트에서 \`/vpn status\` 실행.`,
    );
  }

  await interaction.editReply({ content });
}
```

- [ ] **Step 4: Run tests + full suite**

```bash
npx vitest run src/bot/commands/devsync.test.ts
npx tsc --noEmit
npm test
```

Expected: all green; 3 new tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/bot/commands/devsync.ts src/bot/commands/devsync.test.ts
git -c user.email=a0919376604@gmail.com -c user.name=leric commit -m "feat(devsync): enrich errors with install + VPN hints"
```

---

## Task 11: Smoke checklist in README

**Files:**
- Modify: `README.md` (append smoke section to the existing "Built-in commands" area, or to bottom — whichever fits the file's structure)

- [ ] **Step 1: Find the right insertion point in `README.md`**

Open `README.md` and locate the section that lists existing built-in slash commands (search for `/register` or `/status` mentioned in code-fence). Insert a new sub-section right after that table or list.

If you can't find such a section, append at the very end of the file (before any final `---` or footer):

- [ ] **Step 2: Append this section verbatim**

```markdown
### `/devsync` — Control local Mutagen sync sessions

If you've installed [devsync](https://github.com/leric/devsync) on the bot host
(`uv tool install ~/Desktop/code/devsync`), you can drive it from Discord:

| Subcommand | What it does |
|---|---|
| `/devsync doctor` | Health-check the mutagen daemon + each configured server |
| `/devsync ls` | List active devsync-managed sync sessions |
| `/devsync start <repo> <server>` | Start a new sync session (Reuse/Restart/Cancel buttons if one exists) |
| `/devsync stop <repo>` | Terminate the session for one repo |
| `/devsync stop_all` | Terminate every devsync session (confirm button) |
| `/devsync status <repo>` | Detailed status (staged files, problems) |
| `/devsync flush <repo>` | Force an immediate sync cycle |

**Smoke checklist** (run after every release of this bot):

```
[ ] /devsync doctor                              → 4-server table renders
[ ] /devsync ls                                  → sessions list (or "No active sessions")
[ ] /devsync start foo dl02                      → session created
[ ] /devsync start foo dl02 (repeat)             → 3 buttons appear (Reuse / Restart / Cancel)
[ ] press Cancel                                 → message edits to "Cancelled."
[ ] press Restart                                → old session terminated, new one starts
[ ] /devsync stop foo                            → session terminated
[ ] /devsync stop_all (with N≥1 sessions)        → 2 buttons (Confirm / Cancel)
[ ] press Confirm                                → all sessions terminated
[ ] autocomplete on /devsync start <server>      → lists dl01..dl04
[ ] autocomplete on /devsync stop <repo>         → lists current repos
[ ] devsync binary missing (PATH manipulation)   → install hint shown
```
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git -c user.email=a0919376604@gmail.com -c user.name=leric commit -m "docs: README — /devsync smoke checklist and command reference"
```

---

## Task 12: Final integration — full test run, tsc, manual smoke

**Files:** none new

- [ ] **Step 1: Full vitest run**

```bash
npm test
```

Expected: all tests pass (existing + ~22 new devsync tests).

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Restart bot and verify slash commands register**

```bash
# stop currently running bot (if any), then:
npm run dev
```

Expected log line: `Registered N slash commands (15 bot-owned, M plugin-derived)` — note `15` is `14 + 1` (the new `devsync`). If the count is still 14, the import is wrong.

- [ ] **Step 4: Run smoke checklist from Task 11 in Discord**

Open the Discord channel where the bot is active and run each line of the smoke checklist. Tick each box as it passes.

- [ ] **Step 5: Tag**

If all 12 checklist items pass:

```bash
git tag -a devsync-cmd-v0.1 -m "claudecode-discord: /devsync slash command v0.1

Adds /devsync slash command with 7 subcommands wrapping the local
devsync CLI: doctor / ls / start / stop / stop_all / status / flush.
Conflict-handling and bulk-stop confirmation use Discord buttons.
Server autocomplete from ~/.config/devsync/config.toml; repo
autocomplete from live \`devsync ls\` output.

See docs/superpowers/specs/2026-06-03-devsync-slash-command-design.md."
git log --oneline | head -15
git tag --list | grep devsync
```

---

## Out of Scope (deferred to v0.2+)

Per the spec §11:

- `/devsync logs <repo>` (Mutagen monitor is tail-follow — not slash-command friendly)
- `/devsync ssh <repo>` (TTY interactivity — not slash-command friendly)
- Embed-based rendering (v0.1 uses code blocks)
- Korean i18n strings (v0.1 uses `L(en, en_placeholder)` where Korean wasn't trivially translatable)
- Caching autocomplete output (spawn-per-keystroke is fine at <100ms)
- Multi-machine aggregation

---

## Acceptance Criteria Coverage

| Spec AC | Verified by | Task(s) |
|---|---|---|
| AC-001 (read-only smoke) | Task 2/3 + smoke step 1-2 | 2, 3, 12 |
| AC-002 (ls output matches CLI 1:1) | Task 3 test "passes through" + smoke step 2 | 3, 12 |
| AC-003 (start no-conflict creates session) | Task 7 test "no existing session" + smoke step 3 | 7, 12 |
| AC-004 (start conflict shows 3 buttons) | Task 7 test "existing session" + smoke step 4 | 7, 12 |
| AC-005 (Restart terminates + recreates) | Task 7 button-handler test "stops then starts" + smoke step 5 | 7, 12 |
| AC-006 (stop_all requires confirm) | Task 6 tests + smoke step 8 | 6, 12 |
| AC-007 (server autocomplete) | Task 8 tests + smoke step 10 | 8, 12 |
| AC-008 (repo autocomplete) | Task 9 tests + smoke step 11 | 9, 12 |
| AC-009 (VPN-down hint) | Task 10 test "VPN hint" + smoke (manual VPN disconnect) | 10, 12 |
| AC-010 (install-missing hint) | Task 10 test "install hint" + smoke step 12 | 10, 12 |
