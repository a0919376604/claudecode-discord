# Multi-Agent Backend (Claude / Codex) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each Discord channel choose between Claude Code and OpenAI Codex CLI as its agent backend, with fully aligned UX (Discord approval buttons, streaming output, Stop button, session resume all work identically across backends).

**Architecture:** Extract a backend-agnostic `AgentBackend` interface with a normalized event stream (`NormalizedEvent` union). `ClaudeBackend` wraps `@anthropic-ai/claude-agent-sdk`'s `query()`. `CodexBackend` spawns `codex app-server` and speaks JSON-RPC 2.0 over stdio. `SessionManager` becomes a thin router that consumes the normalized event stream and drives Discord UI — its existing streaming/heartbeat/queue/wakeup logic (~750 lines) is preserved verbatim. Per-channel backend selection persists in `projects.backend` SQLite column.

**Tech Stack:** TypeScript ESM (strict, `noUnusedLocals`), Node ≥ 20, discord.js v14, better-sqlite3, `@anthropic-ai/claude-agent-sdk`, `codex` CLI (external, spawned as subprocess), vitest, zod v4.

**Spec:** [`docs/superpowers/specs/2026-09-08-multi-agent-backend-design.md`](../specs/2026-09-08-multi-agent-backend-design.md)

## Global Constraints

- **Zero regression to existing Claude UX.** After M1 refactor, every current behavior (streaming edit throttle, heartbeat, tool approval buttons, `/stop`, `/auto-approve`, session resume across bot restart, wakeup, `AskUserQuestion`, `pendingCustomInputs`) must remain identical. This is the acceptance gate for every M1 task.
- **`src/agent/` cannot import `discord.js`.** Backends are pure logic — Discord UI lives elsewhere.
- **`src/claude/session-manager.ts` cannot import any SDK.** Only the `AgentBackend` interface.
- **ESM imports use `.js` suffix** (project convention).
- **TypeScript strict + `noUnusedLocals` + `noUnusedParameters`** — do not silence with `_` prefix unless truly unused.
- **Cross-platform paths:** `path.join()` / `path.resolve()`. Never string-concat paths. File name extraction uses `split(/[\\/]/)`.
- **i18n:** All user-visible strings go through `L(en, ko)` helper from `src/utils/i18n.ts`.
- **DB migrations:** Use the existing pattern (`PRAGMA table_info` guard + `ALTER TABLE`). Idempotent, safe to re-run.
- **Test framework:** vitest. Test files are `*.test.ts` alongside sources.
- **Commit granularity:** One commit per task. Message prefix follows repo convention (`feat:`, `refactor:`, `test:`, `fix:`, `docs:`).

## File structure

**New files:**

| Path | Responsibility |
|---|---|
| `src/agent/backend.ts` | `AgentBackend` interface, `NormalizedEvent` union, `BackendStartOptions`, `AskQuestionData` re-export |
| `src/agent/mock-backend.ts` | `MockAgentBackend` test helper — emits scripted events for integration tests |
| `src/agent/claude-translate.ts` | Pure function `sdkMessageToEvent(msg): NormalizedEvent \| null` — fully unit-testable |
| `src/agent/claude-translate.test.ts` | Tests for pure translator |
| `src/agent/claude-backend.ts` | `ClaudeBackend` class — wraps `query()`, wires `canUseTool` into event queue |
| `src/agent/claude-backend.test.ts` | Tests for event-queue drain + interrupt-resolves-pending semantics |
| `src/agent/backend-factory.ts` | `getBackend(channelId)` — returns ClaudeBackend or CodexBackend based on `project.backend` |
| `src/agent/codex-rpc.ts` | JSON-RPC 2.0 over Duplex stream (Content-Length framing, id-paired promises, bidirectional requests) |
| `src/agent/codex-rpc.test.ts` | Frame codec + request pairing + reverse-request dispatch tests |
| `src/agent/codex-translate.ts` | Pure function `notificationToEvent(n): NormalizedEvent \| null` |
| `src/agent/codex-translate.test.ts` | Tests for pure translator |
| `src/agent/codex-backend.ts` | `CodexBackend` — spawns `codex app-server`, wires RPC + translator, handles reverse approvals |
| `src/agent/codex-backend.test.ts` | Tests for CodexBackend using mock RPC transport |
| `src/agent/codex-detect.ts` | `detectCodex()` — three-stage check with formatted Discord error messages |
| `src/agent/codex-detect.test.ts` | Tests for each detection failure mode |
| `src/bot/commands/switch-backend.ts` | `createSwitchBackendCommand(target, displayName)` factory |
| `src/bot/commands/claude.ts` | `/claude` command (uses factory) |
| `src/bot/commands/codex.ts` | `/codex` command (uses factory) |
| `src/bot/commands/switch-backend.test.ts` | Behavior-matrix tests for factory |
| `scripts/codex-rpc-demo.mjs` | Manual verification: connects to `codex app-server`, sends hello world |

**Modified files:**

| Path | Change |
|---|---|
| `src/db/database.ts` | Add `backend` column migration; export `setBackend()` query |
| `src/db/types.ts` | Add `backend: "claude" \| "codex"` to `Project` |
| `src/claude/session-manager.ts` | Replace `query()` call with `backend.start()` event loop; move `ensureFreshCredentials` out |
| `src/claude/output-formatter.ts` | `createResultEmbed`: hide cost row when `costUsd === undefined` |
| `src/bot/handlers/interaction.ts` | Handle `switch-<target>-<channelId>-<yes\|no>` button IDs |
| `src/bot/client.ts` | Register `/claude` and `/codex` slash commands |
| `README.md`, `README.kr.md`, `SETUP.md`, `SETUP.kr.md` | Document `/claude` / `/codex` and codex setup |

---

## Milestone 1 — Refactor without Codex

**Goal:** Extract `AgentBackend` abstraction and refactor `SessionManager` to consume events. After M1, functionality is identical to today — the ONLY observable change is the code structure.

**M1 acceptance gate:** All existing tests green + manual smoke test of a fresh Claude session (send message → get streamed response → approve a Write tool → get result embed) + resume test (send → wait → send again, second should resume).

---

### Task 1: Define `AgentBackend` contract (types only)

**Files:**
- Create: `src/agent/backend.ts`

**Interfaces:**
- Consumes: `AskQuestionData` from `src/claude/output-formatter.ts`
- Produces: `AgentBackend`, `NormalizedEvent`, `BackendStartOptions`

- [ ] **Step 1: Create the file with full type definitions**

`src/agent/backend.ts`:

```ts
import type { AskQuestionData } from "../claude/output-formatter.js";

export type NormalizedEvent =
  | { type: "session_init"; sessionId: string }
  | { type: "text_delta"; text: string; isReasoning?: boolean }
  | { type: "tool_start"; toolName: string; input: Record<string, unknown> }
  | { type: "tool_end"; toolName: string; ok: boolean }
  | { type: "result"; text: string; costUsd?: number; isError: boolean }
  | { type: "tool_approval_request"; requestId: string; toolName: string; input: Record<string, unknown> }
  | { type: "ask_question_request"; requestId: string; questions: AskQuestionData[] };

export interface BackendStartOptions {
  prompt: string;
  cwd: string;
  resumeSessionId?: string;
  skipPermissions: boolean;
  channelId: string;
  model?: string;
}

export interface AgentBackend {
  start(opts: BackendStartOptions): AsyncIterableIterator<NormalizedEvent>;
  interrupt(): Promise<void>;
  respondToApproval(requestId: string, decision: "allow" | "deny", message?: string): void;
  respondToQuestion(requestId: string, answersByQuestionText: Record<string, string>): void;
  isResumeStaleError(error: unknown): boolean;
  getAuthErrorHint(error: unknown): string | null;
}

/** Re-export for downstream consumers. */
export type { AskQuestionData };
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/agent/backend.ts
git commit -m "feat(agent): add AgentBackend contract and NormalizedEvent union"
```

---

### Task 2: `MockAgentBackend` for integration tests

**Files:**
- Create: `src/agent/mock-backend.ts`

**Interfaces:**
- Consumes: `AgentBackend`, `NormalizedEvent`, `BackendStartOptions` from Task 1
- Produces: `MockAgentBackend` class with `enqueueEvent(event)`, `endStream()` control methods

- [ ] **Step 1: Implement the mock**

`src/agent/mock-backend.ts`:

```ts
import type { AgentBackend, BackendStartOptions, NormalizedEvent } from "./backend.js";

/**
 * Test helper: an AgentBackend that emits events you push into it.
 * Used by session-manager integration tests to exercise the full Discord
 * UI flow without spawning a real SDK.
 */
export class MockAgentBackend implements AgentBackend {
  private events: NormalizedEvent[] = [];
  private resolvers: ((v: IteratorResult<NormalizedEvent>) => void)[] = [];
  private ended = false;
  private pendingApprovals = new Map<string, (decision: "allow" | "deny") => void>();
  private pendingQuestions = new Map<string, (answers: Record<string, string>) => void>();

  public lastStartOptions: BackendStartOptions | null = null;
  public interruptCalled = 0;
  public approvalResponses: Array<{ requestId: string; decision: "allow" | "deny" }> = [];
  public questionResponses: Array<{ requestId: string; answers: Record<string, string> }> = [];

  enqueueEvent(event: NormalizedEvent): void {
    if (event.type === "tool_approval_request") {
      // Test can wait for the recorded requestId, then call respondToApproval.
    }
    if (event.type === "ask_question_request") {
      // Same for questions.
    }
    if (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()!;
      resolve({ value: event, done: false });
    } else {
      this.events.push(event);
    }
  }

  endStream(): void {
    this.ended = true;
    while (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()!;
      resolve({ value: undefined, done: true });
    }
  }

  async *start(opts: BackendStartOptions): AsyncIterableIterator<NormalizedEvent> {
    this.lastStartOptions = opts;
    while (true) {
      if (this.events.length > 0) {
        yield this.events.shift()!;
        continue;
      }
      if (this.ended) return;
      const next = await new Promise<IteratorResult<NormalizedEvent>>((resolve) => {
        this.resolvers.push(resolve);
      });
      if (next.done) return;
      yield next.value;
    }
  }

  async interrupt(): Promise<void> {
    this.interruptCalled++;
    for (const [, resolve] of this.pendingApprovals) resolve("deny");
    this.pendingApprovals.clear();
    for (const [, resolve] of this.pendingQuestions) resolve({});
    this.pendingQuestions.clear();
    this.endStream();
  }

  respondToApproval(requestId: string, decision: "allow" | "deny"): void {
    this.approvalResponses.push({ requestId, decision });
    this.pendingApprovals.get(requestId)?.(decision);
    this.pendingApprovals.delete(requestId);
  }

  respondToQuestion(requestId: string, answersByQuestionText: Record<string, string>): void {
    this.questionResponses.push({ requestId, answers: answersByQuestionText });
    this.pendingQuestions.get(requestId)?.(answersByQuestionText);
    this.pendingQuestions.delete(requestId);
  }

  isResumeStaleError(_error: unknown): boolean {
    return false;
  }

  getAuthErrorHint(_error: unknown): string | null {
    return null;
  }
}
```

- [ ] **Step 2: Verify compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/agent/mock-backend.ts
git commit -m "test(agent): add MockAgentBackend for integration tests"
```

---

### Task 3: Pure translator for Claude SDK messages

**Files:**
- Create: `src/agent/claude-translate.ts`
- Create: `src/agent/claude-translate.test.ts`

**Interfaces:**
- Consumes: `NormalizedEvent` from Task 1
- Produces: `sdkMessageToEvent(msg: unknown): NormalizedEvent | null`

- [ ] **Step 1: Write the failing tests**

`src/agent/claude-translate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { sdkMessageToEvent } from "./claude-translate.js";

describe("sdkMessageToEvent", () => {
  it("translates system init to session_init", () => {
    const msg = { type: "system", subtype: "init", session_id: "abc-123" };
    expect(sdkMessageToEvent(msg)).toEqual({ type: "session_init", sessionId: "abc-123" });
  });

  it("ignores system messages without session_id", () => {
    expect(sdkMessageToEvent({ type: "system", subtype: "init" })).toBeNull();
  });

  it("translates assistant text blocks to text_delta events (one per block)", () => {
    const msg = {
      type: "assistant",
      content: [
        { type: "text", text: "hello " },
        { type: "text", text: "world" },
      ],
    };
    // Translator returns null for multi-block; caller iterates.
    // Instead we test a helper that returns an array:
    // For MVP, translator yields ONE event per call — caller loops content[].
    // So test the single-block case:
    const single = { type: "assistant", content: [{ type: "text", text: "hi" }] };
    expect(sdkMessageToEvent(single)).toEqual({ type: "text_delta", text: "hi" });
  });

  it("translates result success", () => {
    const msg = {
      type: "result",
      subtype: "success",
      result: "done",
      total_cost_usd: 0.05,
      duration_ms: 1000,
    };
    expect(sdkMessageToEvent(msg)).toEqual({
      type: "result",
      text: "done",
      costUsd: 0.05,
      isError: false,
    });
  });

  it("translates result error via subtype", () => {
    const msg = {
      type: "result",
      subtype: "error_during_execution",
      errors: ["boom"],
      is_error: true,
    };
    expect(sdkMessageToEvent(msg)).toEqual({
      type: "result",
      text: "boom",
      costUsd: undefined,
      isError: true,
    });
  });

  it("translates result error via is_error flag", () => {
    const msg = { type: "result", is_error: true, errors: ["oops"] };
    expect(sdkMessageToEvent(msg)?.isError).toBe(true);
  });

  it("falls back to 'Task completed' when result field missing on success", () => {
    const msg = { type: "result", subtype: "success" };
    expect(sdkMessageToEvent(msg)).toMatchObject({ text: "Task completed", isError: false });
  });

  it("falls back to 'Task failed' when errors array empty", () => {
    const msg = { type: "result", is_error: true, errors: [] };
    expect(sdkMessageToEvent(msg)).toMatchObject({ text: "Task failed", isError: true });
  });

  it("returns null for unknown types", () => {
    expect(sdkMessageToEvent({ type: "unknown" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/agent/claude-translate.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement translator**

`src/agent/claude-translate.ts`:

```ts
import type { NormalizedEvent } from "./backend.js";

/**
 * Pure translator: one SDK message → zero or one NormalizedEvent.
 *
 * For `assistant` messages with multiple content blocks, this returns
 * only the FIRST text block; callers must iterate `content[]` themselves
 * and call this per-block (or use `assistantContentToEvents` below).
 *
 * Returns null for messages we don't care about (unknown types, system
 * init without session_id, non-text blocks).
 */
export function sdkMessageToEvent(msg: unknown): NormalizedEvent | null {
  if (!msg || typeof msg !== "object" || !("type" in msg)) return null;
  const m = msg as { type: string; [k: string]: unknown };

  if (m.type === "system" && (m as { subtype?: string }).subtype === "init") {
    const sessionId = (m as { session_id?: string }).session_id;
    if (!sessionId) return null;
    return { type: "session_init", sessionId };
  }

  if (m.type === "assistant") {
    const content = (m as { content?: unknown }).content;
    if (!Array.isArray(content) || content.length === 0) return null;
    const first = content[0];
    if (first && typeof first === "object" && "text" in first && typeof (first as { text: unknown }).text === "string") {
      return { type: "text_delta", text: (first as { text: string }).text };
    }
    return null;
  }

  if (m.type === "result") {
    const r = m as {
      subtype?: string;
      result?: string;
      errors?: string[];
      is_error?: boolean;
      total_cost_usd?: number;
    };
    const isError =
      r.is_error === true || (r.subtype !== undefined && r.subtype !== "success");
    const text = isError
      ? r.errors && r.errors.length > 0
        ? r.errors.join("; ")
        : "Task failed"
      : r.result ?? "Task completed";
    return { type: "result", text, costUsd: r.total_cost_usd, isError };
  }

  return null;
}

/**
 * Convenience: yields one text_delta per text block in an assistant
 * message. Non-text blocks are skipped silently.
 */
export function assistantContentToEvents(msg: unknown): NormalizedEvent[] {
  if (!msg || typeof msg !== "object" || (msg as { type?: string }).type !== "assistant") return [];
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  const out: NormalizedEvent[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && "text" in block && typeof (block as { text: unknown }).text === "string") {
      out.push({ type: "text_delta", text: (block as { text: string }).text });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/agent/claude-translate.test.ts`
Expected: all 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/agent/claude-translate.ts src/agent/claude-translate.test.ts
git commit -m "feat(agent): add pure translator for Claude SDK messages"
```

---

### Task 4: `ClaudeBackend` class

**Files:**
- Create: `src/agent/claude-backend.ts`
- Create: `src/agent/claude-backend.test.ts`

**Interfaces:**
- Consumes: `AgentBackend`, `NormalizedEvent`, `BackendStartOptions` (Task 1); `assistantContentToEvents`, `sdkMessageToEvent` (Task 3)
- Produces: `ClaudeBackend` class implementing `AgentBackend`

**Note on porting:** This task moves logic from `src/claude/session-manager.ts` (the entire `runQuery` factory and `canUseTool` handler). Move `ensureFreshCredentials()` call here too — SessionManager no longer needs it.

- [ ] **Step 1: Write the failing tests**

`src/agent/claude-backend.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ClaudeBackend } from "./claude-backend.js";

describe("ClaudeBackend", () => {
  it("interrupt() resolves pending approvals as deny", async () => {
    const backend = new ClaudeBackend();
    // Simulate a pending approval by injecting into the internal map:
    const testResolve = new Promise<{ behavior: string }>((resolve) => {
      (backend as unknown as { pendingApprovals: Map<string, (v: unknown) => void> })
        .pendingApprovals.set("test-id", resolve as (v: unknown) => void);
    });
    await backend.interrupt();
    const decision = await testResolve;
    expect(decision).toMatchObject({ behavior: "deny" });
  });

  it("isResumeStaleError matches known Claude error strings", () => {
    const backend = new ClaudeBackend();
    expect(backend.isResumeStaleError(new Error("No conversation found"))).toBe(true);
    expect(backend.isResumeStaleError(new Error("session not found"))).toBe(true);
    expect(backend.isResumeStaleError(new Error("process exited with code 1"))).toBe(true);
    expect(backend.isResumeStaleError(new Error("random other error"))).toBe(false);
  });

  it("getAuthErrorHint returns claude login hint for auth errors", () => {
    const backend = new ClaudeBackend();
    expect(backend.getAuthErrorHint(new Error("credit balance too low"))).toContain("claude login");
    expect(backend.getAuthErrorHint(new Error("unauthorized"))).toContain("claude login");
    expect(backend.getAuthErrorHint(new Error("some other error"))).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/agent/claude-backend.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `ClaudeBackend`**

`src/agent/claude-backend.ts`:

```ts
import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pluginRegistry } from "../bot/client.js";
import { getConfig } from "../utils/config.js";
import { ensureFreshCredentials } from "../claude/credentials-refresher.js";
import { createPreToolUseHook } from "../hooks/pre-tool-use.js";
import { resolveWakeupDir } from "../wakeup/paths.js";
import type { AgentBackend, BackendStartOptions, NormalizedEvent } from "./backend.js";
import { assistantContentToEvents, sdkMessageToEvent } from "./claude-translate.js";

const READ_ONLY_TOOLS = new Set([
  "Read", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite",
]);

const AUTH_KEYWORDS = [
  "credit balance", "not authenticated", "unauthorized", "authentication",
  "login required", "auth token", "expired", "not logged in", "please run /login",
];

const RESUME_STALE_PATTERNS = [
  /process exited with code/,
  /No conversation found/,
  /session not found/,
  /resume/i,
];

export class ClaudeBackend implements AgentBackend {
  private queryInstance: Query | null = null;
  private pendingApprovals = new Map<
    string,
    (decision: { behavior: "allow" | "deny"; updatedInput?: Record<string, unknown>; message?: string }) => void
  >();
  private pendingQuestions = new Map<string, (answers: Record<string, string>) => void>();
  private eventQueue: NormalizedEvent[] = [];
  private queueResolver: (() => void) | null = null;

  private pushEvent(event: NormalizedEvent): void {
    this.eventQueue.push(event);
    if (this.queueResolver) {
      const r = this.queueResolver;
      this.queueResolver = null;
      r();
    }
  }

  private drainQueue(): NormalizedEvent[] {
    const out = this.eventQueue;
    this.eventQueue = [];
    return out;
  }

  async *start(opts: BackendStartOptions): AsyncIterableIterator<NormalizedEvent> {
    await ensureFreshCredentials();

    const skipPerms = opts.skipPermissions;
    this.queryInstance = query({
      prompt: opts.prompt,
      options: {
        cwd: opts.cwd,
        plugins: pluginRegistry.toSdkPluginConfig(),
        permissionMode: skipPerms ? "bypassPermissions" : "default",
        ...(skipPerms ? { allowDangerouslySkipPermissions: true } : {}),
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: undefined,
          PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}`,
          WAKEUP_CHANNEL_ID: opts.channelId,
          WAKEUP_DIR: resolveWakeupDir(),
        },
        ...(opts.resumeSessionId ? { resume: opts.resumeSessionId } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        hooks: {
          PreToolUse: [{
            hooks: [createPreToolUseHook({ channelId: opts.channelId, now: () => Date.now() })],
          }],
        },
        canUseTool: async (toolName, input) => {
          // AskUserQuestion → structured question event
          if (toolName === "AskUserQuestion") {
            const requestId = randomUUID();
            const questions = (input as { questions?: unknown }).questions ?? [];
            this.pushEvent({ type: "ask_question_request", requestId, questions: questions as never });
            const answers = await new Promise<Record<string, string>>((resolve) => {
              this.pendingQuestions.set(requestId, resolve);
            });
            return { behavior: "allow", updatedInput: { ...input, answers } };
          }

          // Progress signal for ALL tools (including read-only)
          this.pushEvent({ type: "tool_start", toolName, input });

          if (READ_ONLY_TOOLS.has(toolName)) {
            return { behavior: "allow", updatedInput: input };
          }

          const requestId = randomUUID();
          this.pushEvent({ type: "tool_approval_request", requestId, toolName, input });
          const decision = await new Promise<{ behavior: "allow" | "deny"; message?: string }>((resolve) => {
            this.pendingApprovals.set(requestId, resolve);
          });
          return decision.behavior === "allow"
            ? { behavior: "allow", updatedInput: input }
            : { behavior: "deny", message: decision.message ?? "Denied by user" };
        },
      },
    });

    // Main event loop: consume SDK messages, translate, interleave canUseTool events
    for await (const message of this.queryInstance) {
      // Flush any events queued by canUseTool since last iteration
      for (const ev of this.drainQueue()) yield ev;

      if ((message as { type?: string }).type === "assistant") {
        for (const ev of assistantContentToEvents(message)) yield ev;
        continue;
      }

      const translated = sdkMessageToEvent(message);
      if (translated) {
        yield translated;
        if (translated.type === "result") return;
      }
    }

    // Final drain in case events queued after last SDK message
    for (const ev of this.drainQueue()) yield ev;
  }

  async interrupt(): Promise<void> {
    if (this.queryInstance) {
      await Promise.race([
        this.queryInstance.interrupt(),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]).catch(() => {});
    }
    // Resolve all pending as deny so SDK doesn't hang
    for (const [, resolve] of this.pendingApprovals) {
      resolve({ behavior: "deny", message: "Interrupted" });
    }
    this.pendingApprovals.clear();
    for (const [, resolve] of this.pendingQuestions) resolve({});
    this.pendingQuestions.clear();
  }

  respondToApproval(requestId: string, decision: "allow" | "deny", message?: string): void {
    const resolver = this.pendingApprovals.get(requestId);
    if (!resolver) return;
    this.pendingApprovals.delete(requestId);
    resolver({ behavior: decision, message });
  }

  respondToQuestion(requestId: string, answersByQuestionText: Record<string, string>): void {
    const resolver = this.pendingQuestions.get(requestId);
    if (!resolver) return;
    this.pendingQuestions.delete(requestId);
    resolver(answersByQuestionText);
  }

  isResumeStaleError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);
    return RESUME_STALE_PATTERNS.some((p) => p.test(msg));
  }

  getAuthErrorHint(error: unknown): string | null {
    const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
    if (AUTH_KEYWORDS.some((kw) => msg.includes(kw))) {
      return "🔑 Claude Code is not logged in. Please open a terminal on the host PC and run `claude login` to authenticate, then try again.";
    }
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/agent/claude-backend.test.ts`
Expected: all 3 tests pass.

- [ ] **Step 5: Verify full project compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/agent/claude-backend.ts src/agent/claude-backend.test.ts
git commit -m "feat(agent): implement ClaudeBackend wrapping Claude Agent SDK"
```

---

### Task 5: `backend-factory` (returns ClaudeBackend only, for now)

**Files:**
- Create: `src/agent/backend-factory.ts`

**Interfaces:**
- Consumes: `AgentBackend` (Task 1), `ClaudeBackend` (Task 4)
- Produces: `getBackend(channelId: string): AgentBackend`

- [ ] **Step 1: Create factory**

`src/agent/backend-factory.ts`:

```ts
import type { AgentBackend } from "./backend.js";
import { ClaudeBackend } from "./claude-backend.js";

/**
 * Returns the AgentBackend for a channel. Reads `project.backend` from DB.
 * Callers must have verified the project is registered.
 *
 * For now, always returns ClaudeBackend. M3 wires in CodexBackend based on
 * the `backend` column added by Task 11.
 */
export function getBackend(_channelId: string): AgentBackend {
  return new ClaudeBackend();
}
```

- [ ] **Step 2: Compile check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/agent/backend-factory.ts
git commit -m "feat(agent): add backend-factory (Claude-only stub for M1)"
```

---

### Task 6: Refactor `SessionManager` to consume event stream

**Files:**
- Modify: `src/claude/session-manager.ts`

**Interfaces:**
- Consumes: `AgentBackend`, `NormalizedEvent`, `BackendStartOptions` (Task 1); `getBackend` (Task 5)
- Produces: unchanged public API (`sendMessage`, `stopSession`, `isActive`, `resolveApproval`, `resolveQuestion`, `resolveCustomInput`, `hasPendingCustomInput`, all queue methods, `wakeUp`)

**Refactor rules:**
1. **Delete** the `runQuery` inline factory (lines ~292-486 in current file).
2. **Delete** `import { query, type Query }` — no more SDK import.
3. **Delete** `import { ensureFreshCredentials }` — moved into ClaudeBackend.
4. **Delete** `import { pluginRegistry }` from client.ts — only ClaudeBackend uses it now.
5. **Delete** `import { createPreToolUseHook }` — only ClaudeBackend uses it now.
6. **Delete** `import { resolveWakeupDir }` — only ClaudeBackend uses it now.
7. **Change** `ActiveSession.queryInstance: Query` → drop this field. Replace with a reference to the backend so `stopSession` can call `interrupt()` on it. New field: `backend: AgentBackend`.
8. **Change** the main loop from `for await (const message of queryInstance)` to `for await (const event of eventStream)`, with a switch on `event.type`.
9. **Change** `stopSession()`: instead of `session.queryInstance.interrupt()`, call `session.backend.interrupt()`.
10. **Keep** everything else identical (buffer flush, heartbeat, progress, DB updates, queue, wakeup, resume-retry, finally cleanup).

- [ ] **Step 1: Update imports and ActiveSession type**

At top of file, add:
```ts
import type { AgentBackend } from "../agent/backend.js";
import { getBackend } from "../agent/backend-factory.js";
```

Remove:
```ts
import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import { pluginRegistry } from "../bot/client.js";
import { ensureFreshCredentials } from "./credentials-refresher.js";
import { createPreToolUseHook } from "../hooks/pre-tool-use.js";
import { resolveWakeupDir } from "../wakeup/paths.js";
```

Change `ActiveSession`:
```ts
interface ActiveSession {
  backend: AgentBackend;
  channelId: string;
  sessionId: string | null;
  dbId: string;
}
```

- [ ] **Step 2: Remove `ensureFreshCredentials()` call from sendMessage**

Delete the line `await ensureFreshCredentials();` near the top of `sendMessage`. (It's now inside `ClaudeBackend.start()`.)

- [ ] **Step 3: Replace `runQuery` with `runBackend`**

Delete the entire `runQuery = (useResume: boolean) => query({...})` factory (~200 lines including the huge `canUseTool` block).

Replace with:
```ts
const backend = getBackend(channelId);
const runBackend = (useResume: boolean) =>
  backend.start({
    prompt,
    cwd: project.project_path,
    resumeSessionId: useResume ? resumeSessionId : undefined,
    skipPermissions: isSkipPermissionsEnabled(),
    channelId,
    channel,   // NEW required field — see ledger Ruling R2 (Task 4 fix round 1)
    model: getConfig().CLAUDE_MODEL,
  });

let eventStream = runBackend(Boolean(resumeSessionId));
let attemptedResume = Boolean(resumeSessionId);
```

- [ ] **Step 4: Replace the main event loop**

Replace the `for await (const message of queryInstance) { ... }` block with:

```ts
for await (const event of eventStream) {
  switch (event.type) {
    case "session_init": {
      const active = this.sessions.get(channelId);
      if (active) active.sessionId = event.sessionId;
      upsertSession(dbId, channelId, event.sessionId, "online");
      break;
    }

    case "text_delta": {
      responseBuffer += event.text;
      hasTextOutput = true;
      const now = Date.now();
      if (now - lastEditTime >= EDIT_INTERVAL && responseBuffer.length > 0) {
        lastEditTime = now;
        lastTextTime = now;
        progressMessage = null;
        if (bufferFinalized) {
          currentMessage = await channel.send("...");
          bufferFinalized = false;
        }
        const { tail, remainingBuffer } = await flushStreamBuffer(channel, currentMessage, responseBuffer);
        currentMessage = tail;
        responseBuffer = remainingBuffer;
      }
      break;
    }

    case "tool_start": {
      toolUseCount++;
      const toolLabels: Record<string, string> = {
        Read: L("Reading files", "파일 읽는 중"),
        Glob: L("Searching files", "파일 검색 중"),
        Grep: L("Searching code", "코드 검색 중"),
        Write: L("Writing file", "파일 작성 중"),
        Edit: L("Editing file", "파일 편집 중"),
        Bash: L("Running command", "명령어 실행 중"),
        WebSearch: L("Searching web", "웹 검색 중"),
        WebFetch: L("Fetching URL", "URL 가져오는 중"),
        TodoWrite: L("Updating tasks", "작업 업데이트 중"),
      };
      const filePath = typeof event.input.file_path === "string"
        ? ` \`${(event.input.file_path as string).split(/[\\/]/).pop()}\``
        : "";
      lastActivity = `${toolLabels[event.toolName] ?? `Using ${event.toolName}`}${filePath}`;
      await surfaceProgress();
      break;
    }

    case "tool_approval_request": {
      // Flush buffered text so user sees Claude's explanation before the button
      if (responseBuffer.length > 0) {
        const { tail } = await flushStreamBuffer(channel, currentMessage, responseBuffer);
        currentMessage = tail;
        responseBuffer = "";
        bufferFinalized = true;
        lastEditTime = Date.now();
      }
      // Auto-approve check
      const currentProject = getProject(channelId);
      if (currentProject?.auto_approve) {
        backend.respondToApproval(event.requestId, "allow");
        break;
      }
      // Discord button
      const { embed, row } = createToolApprovalEmbed(event.toolName, event.input, event.requestId);
      updateSessionStatus(channelId, "waiting");
      await channel.send({ embeds: [embed], components: [row] });
      const timeout = setTimeout(() => {
        pendingApprovals.delete(event.requestId);
        updateSessionStatus(channelId, "online");
        backend.respondToApproval(event.requestId, "deny", "Approval timed out");
      }, 5 * 60 * 1000);
      pendingApprovals.set(event.requestId, {
        resolve: (decision) => {
          clearTimeout(timeout);
          pendingApprovals.delete(event.requestId);
          updateSessionStatus(channelId, "online");
          backend.respondToApproval(
            event.requestId,
            decision.behavior === "allow" ? "allow" : "deny",
            decision.message,
          );
        },
        channelId,
      });
      break;
    }

    case "ask_question_request": {
      if (responseBuffer.length > 0) {
        const { tail } = await flushStreamBuffer(channel, currentMessage, responseBuffer);
        currentMessage = tail;
        responseBuffer = "";
        bufferFinalized = true;
        lastEditTime = Date.now();
      }
      const answers: Record<string, string> = {};
      let timedOut = false;
      for (let qi = 0; qi < event.questions.length; qi++) {
        const q = event.questions[qi];
        const qRequestId = randomUUID();
        const { embed, components } = createAskUserQuestionEmbed(q, qRequestId, qi, event.questions.length);
        updateSessionStatus(channelId, "waiting");
        await channel.send({ embeds: [embed], components });
        const answer = await new Promise<string | null>((resolve) => {
          const t = setTimeout(() => {
            pendingQuestions.delete(qRequestId);
            const ci = pendingCustomInputs.get(channelId);
            if (ci?.requestId === qRequestId) pendingCustomInputs.delete(channelId);
            resolve(null);
          }, 5 * 60 * 1000);
          pendingQuestions.set(qRequestId, {
            resolve: (ans) => { clearTimeout(t); pendingQuestions.delete(qRequestId); resolve(ans); },
            channelId,
          });
        });
        if (answer === null) {
          timedOut = true;
          break;   // exit the question-collection for-loop
        }
        answers[q.question] = answer;
      }
      updateSessionStatus(channelId, "online");
      if (timedOut) {
        // Deny via approval channel — backend translates to SDK-level deny.
        // Then let the for-await continue: the backend's SDK will produce a
        // result event with the denial as the reason, hitting the "result"
        // case below and terminating the turn cleanly. Do NOT return here.
        backend.respondToApproval(event.requestId, "deny", L("Question timed out", "질문 시간 초과"));
      } else {
        backend.respondToQuestion(event.requestId, answers);
      }
      break;
    }

    case "tool_end":
      // Optional signal — no-op for now (heartbeat already covers)
      break;

    case "result": {
      const isError = event.isError;
      const resultText = event.text;
      if (responseBuffer.length > 0) {
        const chunks = splitMessage(responseBuffer);
        try {
          await currentMessage.edit(chunks[0] || L("Done.", "완료."));
          for (let i = 1; i < chunks.length; i++) await channel.send(chunks[i]);
        } catch (e) {
          console.warn(`[flush] Failed to edit final message for ${channelId}:`, e instanceof Error ? e.message : e);
        }
      }
      try {
        await currentMessage.edit({ components: [createCompletedButton()] });
      } catch (e) {
        console.warn(`[complete] Failed to update completed button for ${channelId}:`, e instanceof Error ? e.message : e);
      }
      const resultEmbed = createResultEmbed(
        resultText,
        event.costUsd ?? 0,
        Date.now() - startTime,
        getConfig().SHOW_COST,
        isError,
      );
      await channel.send({
        embeds: [resultEmbed],
        components: [createFinishFeatureButton(channelId)],
      });
      const authHint = backend.getAuthErrorHint(new Error(resultText));
      if (authHint) await channel.send(authHint);
      updateSessionStatus(channelId, isError ? "offline" : "idle");
      hasResult = true;
      break;
    }
  }
}
```

**Control-flow note:** The `ask_question_request` case above uses a
`timedOut` flag rather than `return` so the for-await loop continues
after a question timeout. The backend receives `respondToApproval(..., "deny")`,
its SDK emits a result event as the tool-denial reason, which hits the
`"result"` case and terminates the turn cleanly. The outer `retry:` label
loop's normal termination path handles cleanup.

- [ ] **Step 5: Update `stopSession`**

Replace `session.queryInstance.interrupt()` with `session.backend.interrupt()`. The rest of `stopSession` is unchanged.

- [ ] **Step 6: Update `this.sessions.set()` calls**

Everywhere the code does `this.sessions.set(channelId, { queryInstance, ... })`, change to `{ backend, ... }`.

- [ ] **Step 7: Update resume-retry to use `isResumeStaleError`**

Replace the current `resumeStale` computation:
```ts
const rawMsg = innerError instanceof Error ? innerError.message : String(innerError);
const resumeStale =
  attemptedResume &&
  !hasTextOutput &&
  !hasResult &&
  (rawMsg.includes("process exited with code") ||
    rawMsg.includes("No conversation found") ||
    rawMsg.includes("session not found") ||
    /resume/i.test(rawMsg));
```

with:
```ts
const resumeStale =
  attemptedResume && !hasTextOutput && !hasResult && backend.isResumeStaleError(innerError);
```

- [ ] **Step 8: Update auth-hint block in the catch**

Replace the hardcoded `authKeywords` check with:
```ts
const authHint = backend.getAuthErrorHint(error);
if (authHint) errMsg += "\n\n" + authHint;
```

Delete the old `authKeywords` array and `resultAuthKeywords` array (auth logic now lives in each backend).

- [ ] **Step 9: Compile check**

Run: `npx tsc --noEmit`
Expected: no errors. If there are unused-import warnings, remove them.

- [ ] **Step 10: Run all existing tests**

Run: `npm test`
Expected: all existing tests pass (nothing tested the deleted code paths directly).

- [ ] **Step 11: Manual smoke test**

Start the bot with a real Discord token, send a message that triggers:
1. Streaming text response
2. A tool that needs approval (e.g., "create a file called foo.txt with content bar")
3. Approve via button
4. Get result embed with cost + duration

All should work identically to before.

- [ ] **Step 12: Commit**

```bash
git add src/claude/session-manager.ts
git commit -m "refactor(session-manager): consume normalized event stream via AgentBackend"
```

---

### Task 7: Integration test — SessionManager with MockAgentBackend

**Files:**
- Create: `src/claude/session-manager.test.ts` (new — no existing test file)

**Interfaces:**
- Consumes: `MockAgentBackend` (Task 2); `sessionManager` singleton (Task 6)
- Produces: end-to-end behavioral test that acts as regression safety net

**Note:** This test needs `getBackend` to return a mock. Update `backend-factory.ts` to accept a test override, OR use `vi.mock()` on the factory. Recommended: `vi.mock`.

- [ ] **Step 1: Write the test**

`src/claude/session-manager.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MockAgentBackend } from "../agent/mock-backend.js";

// Mock the factory to return our test backend
const testBackend = new MockAgentBackend();
vi.mock("../agent/backend-factory.js", () => ({
  getBackend: () => testBackend,
}));

// Mock DB layer — sessions and projects
vi.mock("../db/database.js", async () => {
  const actual = await vi.importActual<typeof import("../db/database.js")>("../db/database.js");
  return {
    ...actual,
    getProject: vi.fn(() => ({
      channel_id: "ch1", project_path: "/tmp/proj", guild_id: "g1",
      auto_approve: 0, source_path: null, backend: "claude", created_at: "",
    })),
    getSession: vi.fn(() => undefined),
    upsertSession: vi.fn(),
    updateSessionStatus: vi.fn(),
  };
});

// Mock Discord channel + message
function makeMockChannel() {
  const messages: Array<{ id: string; content: string; embeds?: unknown[]; components?: unknown[] }> = [];
  let id = 0;
  const makeMessage = (content: string, extras?: Record<string, unknown>) => {
    const msg = {
      id: `msg-${++id}`,
      content,
      ...extras,
      edit: vi.fn(async (patch: unknown) => Object.assign(msg, patch)),
    };
    messages.push(msg);
    return msg;
  };
  return {
    id: "ch1",
    messages,
    send: vi.fn(async (payload: string | { content?: string; embeds?: unknown[]; components?: unknown[] }) => {
      if (typeof payload === "string") return makeMessage(payload);
      return makeMessage(payload.content ?? "", payload);
    }),
  } as unknown as import("discord.js").TextChannel;
}

describe("SessionManager with MockAgentBackend", () => {
  beforeEach(() => {
    // Reset backend state between tests
    Object.assign(testBackend, new MockAgentBackend());
  });

  it("streams text_delta events into Discord messages", async () => {
    const { sessionManager } = await import("./session-manager.js");
    const channel = makeMockChannel();

    // Script the backend
    setTimeout(() => {
      testBackend.enqueueEvent({ type: "session_init", sessionId: "sess-1" });
      testBackend.enqueueEvent({ type: "text_delta", text: "Hello world" });
      testBackend.enqueueEvent({ type: "result", text: "done", costUsd: 0.01, isError: false });
      testBackend.endStream();
    }, 10);

    await sessionManager.sendMessage(channel, "test prompt");

    const sends = (channel.send as ReturnType<typeof vi.fn>).mock.calls;
    expect(sends.length).toBeGreaterThan(0);
    expect(testBackend.lastStartOptions).toMatchObject({
      prompt: "test prompt",
      channelId: "ch1",
    });
  });

  it("shows approval button for gated tool and forwards decision to backend", async () => {
    const { sessionManager } = await import("./session-manager.js");
    const channel = makeMockChannel();

    setTimeout(() => {
      testBackend.enqueueEvent({ type: "session_init", sessionId: "sess-2" });
      testBackend.enqueueEvent({
        type: "tool_approval_request",
        requestId: "req-1",
        toolName: "Write",
        input: { file_path: "/tmp/foo.txt", content: "bar" },
      });
    }, 10);

    // Simulate user clicking approve after 50ms
    setTimeout(() => {
      sessionManager.resolveApproval("req-1", "approve");
      // Then finish the turn
      testBackend.enqueueEvent({ type: "result", text: "wrote file", isError: false });
      testBackend.endStream();
    }, 50);

    await sessionManager.sendMessage(channel, "make a file");

    expect(testBackend.approvalResponses).toContainEqual({ requestId: "req-1", decision: "allow" });
  });

  it("interrupt via stopSession propagates to backend.interrupt()", async () => {
    const { sessionManager } = await import("./session-manager.js");
    const channel = makeMockChannel();

    setTimeout(() => {
      testBackend.enqueueEvent({ type: "session_init", sessionId: "sess-3" });
      // Leave stream open — never emit result
    }, 10);

    const promise = sessionManager.sendMessage(channel, "long task");
    // Wait for session to be active
    await new Promise((r) => setTimeout(r, 50));
    expect(sessionManager.isActive("ch1")).toBe(true);
    await sessionManager.stopSession("ch1");
    expect(testBackend.interruptCalled).toBe(1);
    await promise;
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/claude/session-manager.test.ts`
Expected: 3 tests pass. Debug if any fail — the test doubles for Discord/DB may need small tweaks depending on what internal calls SessionManager makes.

- [ ] **Step 3: Commit**

```bash
git add src/claude/session-manager.test.ts
git commit -m "test(session-manager): add integration tests via MockAgentBackend"
```

**M1 milestone complete.** The bot behaves identically to before M1, but the architecture is now backend-agnostic.

---

## Milestone 2 — Codex JSON-RPC Client

**Goal:** Build a standalone, testable JSON-RPC 2.0 client that speaks the codex app-server protocol. No Discord, no SessionManager integration — this is a library.

**M2 acceptance gate:** `codex-rpc.ts` unit tests pass + demo script successfully connects to real `codex app-server`, sends `initialize` + `thread/start` + `turn/start` for "say hello", receives `agentMessage/delta` events, and prints them.

---

### Task 8: JSON-RPC frame codec (Content-Length framing)

**Files:**
- Create: `src/agent/codex-rpc.ts` (initial: codec only)
- Create: `src/agent/codex-rpc.test.ts`

**Interfaces:**
- Consumes: nothing (Node built-ins only)
- Produces:
  - `encodeFrame(json: object): Buffer`
  - `FrameDecoder` class with `push(chunk: Buffer): object[]` (returns any complete messages parsed from accumulated buffer)

- [ ] **Step 1: Write failing tests**

`src/agent/codex-rpc.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { encodeFrame, FrameDecoder } from "./codex-rpc.js";

describe("encodeFrame", () => {
  it("produces LSP-style frame with correct Content-Length", () => {
    const buf = encodeFrame({ jsonrpc: "2.0", id: 1, method: "test" });
    const text = buf.toString("utf-8");
    expect(text).toMatch(/^Content-Length: \d+\r\n\r\n\{/);
    const bodyStart = text.indexOf("\r\n\r\n") + 4;
    const body = text.slice(bodyStart);
    const clMatch = text.match(/Content-Length: (\d+)/);
    expect(Number(clMatch![1])).toBe(Buffer.byteLength(body, "utf-8"));
    expect(JSON.parse(body)).toEqual({ jsonrpc: "2.0", id: 1, method: "test" });
  });

  it("uses byte length not char length for multibyte content", () => {
    const buf = encodeFrame({ msg: "你好" });
    const text = buf.toString("utf-8");
    const clMatch = text.match(/Content-Length: (\d+)/);
    const body = text.slice(text.indexOf("\r\n\r\n") + 4);
    expect(Number(clMatch![1])).toBe(Buffer.byteLength(body, "utf-8"));
  });
});

describe("FrameDecoder", () => {
  it("parses a single complete frame", () => {
    const dec = new FrameDecoder();
    const frame = encodeFrame({ id: 1, method: "hi" });
    const messages = dec.push(frame);
    expect(messages).toEqual([{ id: 1, method: "hi" }]);
  });

  it("buffers when frame arrives in multiple chunks (header split)", () => {
    const dec = new FrameDecoder();
    const frame = encodeFrame({ id: 2 });
    // Split mid-header
    expect(dec.push(frame.slice(0, 5))).toEqual([]);
    expect(dec.push(frame.slice(5))).toEqual([{ id: 2 }]);
  });

  it("buffers when frame arrives in multiple chunks (body split)", () => {
    const dec = new FrameDecoder();
    const frame = encodeFrame({ id: 3, method: "long method name here" });
    const headerEnd = frame.indexOf(Buffer.from("\r\n\r\n")) + 4;
    expect(dec.push(frame.slice(0, headerEnd + 3))).toEqual([]);
    expect(dec.push(frame.slice(headerEnd + 3))).toEqual([{ id: 3, method: "long method name here" }]);
  });

  it("parses multiple frames in one push", () => {
    const dec = new FrameDecoder();
    const combined = Buffer.concat([encodeFrame({ id: 1 }), encodeFrame({ id: 2 })]);
    expect(dec.push(combined)).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("throws on invalid JSON body", () => {
    const dec = new FrameDecoder();
    // Hand-craft invalid frame
    const bad = Buffer.from("Content-Length: 5\r\n\r\n{oops");
    expect(() => dec.push(bad)).toThrow();
  });

  it("ignores unknown headers before Content-Length", () => {
    const dec = new FrameDecoder();
    const body = '{"id":9}';
    const bytes = Buffer.byteLength(body, "utf-8");
    const frame = Buffer.from(`Content-Type: application/json\r\nContent-Length: ${bytes}\r\n\r\n${body}`);
    expect(dec.push(frame)).toEqual([{ id: 9 }]);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run src/agent/codex-rpc.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement codec**

`src/agent/codex-rpc.ts` (initial version, more added in later tasks):

```ts
export function encodeFrame(payload: object): Buffer {
  const json = JSON.stringify(payload);
  const body = Buffer.from(json, "utf-8");
  const header = Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, "utf-8");
  return Buffer.concat([header, body]);
}

export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): object[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: object[] = [];

    while (true) {
      const headerEnd = this.buffer.indexOf(Buffer.from("\r\n\r\n"));
      if (headerEnd === -1) break;

      const headerText = this.buffer.slice(0, headerEnd).toString("utf-8");
      const clMatch = headerText.match(/Content-Length:\s*(\d+)/i);
      if (!clMatch) {
        throw new Error(`Missing Content-Length header in frame: ${headerText}`);
      }
      const contentLength = Number(clMatch[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;

      if (this.buffer.byteLength < bodyEnd) break;

      const body = this.buffer.slice(bodyStart, bodyEnd).toString("utf-8");
      let parsed: object;
      try {
        parsed = JSON.parse(body);
      } catch (e) {
        throw new Error(`Invalid JSON in frame body: ${e instanceof Error ? e.message : e}`);
      }
      messages.push(parsed);
      this.buffer = this.buffer.slice(bodyEnd);
    }

    return messages;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/agent/codex-rpc.test.ts`
Expected: all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/agent/codex-rpc.ts src/agent/codex-rpc.test.ts
git commit -m "feat(agent): add JSON-RPC frame codec (Content-Length framing)"
```

---

### Task 9: `CodexRpc` class — request/response pairing

**Files:**
- Modify: `src/agent/codex-rpc.ts` (add `CodexRpc` class)
- Modify: `src/agent/codex-rpc.test.ts` (add class tests)

**Interfaces:**
- Consumes: `encodeFrame`, `FrameDecoder` (Task 8)
- Produces:
  - `CodexRpc` class taking a `Duplex` stream
  - `rpc.request(method: string, params?: unknown): Promise<unknown>` — id-paired
  - `rpc.notify(method: string, params?: unknown): void` — no reply expected
  - `rpc.close(): void`

- [ ] **Step 1: Write failing tests**

Append to `src/agent/codex-rpc.test.ts`:

```ts
import { Duplex } from "node:stream";
import { CodexRpc } from "./codex-rpc.js";

function makeStreamPair() {
  const client = new Duplex({ read() {}, write(chunk, _enc, cb) { server.push(chunk); cb(); } });
  const server = new Duplex({ read() {}, write(chunk, _enc, cb) { client.push(chunk); cb(); } });
  return { client, server };
}

describe("CodexRpc.request", () => {
  it("pairs response to request by id and resolves promise", async () => {
    const { client, server } = makeStreamPair();
    const rpc = new CodexRpc(client);
    const serverDecoder = new FrameDecoder();
    server.on("data", (chunk: Buffer) => {
      for (const msg of serverDecoder.push(chunk)) {
        const req = msg as { id: number; method: string };
        // Echo a success response
        server.push(encodeFrame({ jsonrpc: "2.0", id: req.id, result: { got: req.method } }));
      }
    });

    const result = await rpc.request("ping");
    expect(result).toEqual({ got: "ping" });
    rpc.close();
  });

  it("rejects on server error response", async () => {
    const { client, server } = makeStreamPair();
    const rpc = new CodexRpc(client);
    const dec = new FrameDecoder();
    server.on("data", (chunk: Buffer) => {
      for (const msg of dec.push(chunk)) {
        const req = msg as { id: number };
        server.push(encodeFrame({ jsonrpc: "2.0", id: req.id, error: { code: -1, message: "boom" } }));
      }
    });
    await expect(rpc.request("bad")).rejects.toThrow("boom");
    rpc.close();
  });

  it("assigns unique ascending ids to concurrent requests", async () => {
    const { client, server } = makeStreamPair();
    const rpc = new CodexRpc(client);
    const dec = new FrameDecoder();
    const receivedIds: number[] = [];
    server.on("data", (chunk: Buffer) => {
      for (const msg of dec.push(chunk)) {
        const req = msg as { id: number };
        receivedIds.push(req.id);
        server.push(encodeFrame({ jsonrpc: "2.0", id: req.id, result: "ok" }));
      }
    });
    await Promise.all([rpc.request("a"), rpc.request("b"), rpc.request("c")]);
    expect(new Set(receivedIds).size).toBe(3);
    rpc.close();
  });

  it("notify() sends without id and does not create a pending entry", async () => {
    const { client, server } = makeStreamPair();
    const rpc = new CodexRpc(client);
    const dec = new FrameDecoder();
    let received: { id?: number; method?: string } | null = null;
    server.on("data", (chunk: Buffer) => {
      for (const msg of dec.push(chunk)) received = msg as { id?: number; method?: string };
    });
    rpc.notify("hello", { x: 1 });
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toEqual({ jsonrpc: "2.0", method: "hello", params: { x: 1 } });
    rpc.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/agent/codex-rpc.test.ts`
Expected: FAIL (CodexRpc not exported).

- [ ] **Step 3: Implement `CodexRpc` class**

Append to `src/agent/codex-rpc.ts`:

```ts
import type { Duplex } from "node:stream";

type PendingResolver = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

export class CodexRpc {
  private nextId = 1;
  private pending = new Map<number, PendingResolver>();
  private decoder = new FrameDecoder();
  private closed = false;

  constructor(private stream: Duplex) {
    stream.on("data", (chunk: Buffer) => this.onData(chunk));
    stream.on("error", (err) => this.rejectAll(err));
    stream.on("close", () => this.rejectAll(new Error("Stream closed")));
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("RPC closed"));
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.stream.write(encodeFrame({ jsonrpc: "2.0", id, method, params }));
    return promise;
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.stream.write(encodeFrame({ jsonrpc: "2.0", method, params }));
  }

  close(): void {
    this.closed = true;
    this.rejectAll(new Error("RPC closed"));
    this.stream.end();
  }

  private onData(chunk: Buffer): void {
    let messages: object[];
    try {
      messages = this.decoder.push(chunk);
    } catch (e) {
      this.rejectAll(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    for (const msg of messages) this.dispatch(msg);
  }

  protected dispatch(msg: object): void {
    const m = msg as { id?: number; result?: unknown; error?: { message?: string } };
    if (typeof m.id === "number" && this.pending.has(m.id)) {
      const pending = this.pending.get(m.id)!;
      this.pending.delete(m.id);
      if (m.error) pending.reject(new Error(m.error.message ?? "RPC error"));
      else pending.resolve(m.result);
    }
    // Notifications and reverse requests handled in subclass (Task 10)
  }

  private rejectAll(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/agent/codex-rpc.test.ts`
Expected: all tests (previous 8 + new 4) pass.

- [ ] **Step 5: Commit**

```bash
git add src/agent/codex-rpc.ts src/agent/codex-rpc.test.ts
git commit -m "feat(agent): add CodexRpc client with id-paired request/response"
```

---

### Task 10: `CodexRpc` — bidirectional support (notifications + reverse requests)

**Files:**
- Modify: `src/agent/codex-rpc.ts`
- Modify: `src/agent/codex-rpc.test.ts`

**Interfaces (added to `CodexRpc`):**
- `onNotification(method: string, handler: (params: unknown) => void): void`
- `onRequest(method: string, handler: (params: unknown) => Promise<unknown>): void`
- `notifications(): AsyncIterableIterator<{ method: string; params: unknown }>` — convenience iterator for the main loop

- [ ] **Step 1: Write failing tests**

Append to `src/agent/codex-rpc.test.ts`:

```ts
describe("CodexRpc bidirectional", () => {
  it("dispatches server notifications to registered handler", async () => {
    const { client, server } = makeStreamPair();
    const rpc = new CodexRpc(client);
    let received: unknown = null;
    rpc.onNotification("progress", (params) => { received = params; });
    server.push(encodeFrame({ jsonrpc: "2.0", method: "progress", params: { pct: 50 } }));
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toEqual({ pct: 50 });
    rpc.close();
  });

  it("dispatches reverse requests and sends handler result as response", async () => {
    const { client, server } = makeStreamPair();
    const rpc = new CodexRpc(client);
    rpc.onRequest("approve", async (params) => {
      const p = params as { cmd: string };
      return { ok: p.cmd === "ls" };
    });
    const dec = new FrameDecoder();
    const responses: unknown[] = [];
    server.on("data", (chunk: Buffer) => {
      for (const msg of dec.push(chunk)) responses.push(msg);
    });
    server.push(encodeFrame({ jsonrpc: "2.0", id: 99, method: "approve", params: { cmd: "ls" } }));
    await new Promise((r) => setTimeout(r, 20));
    expect(responses).toContainEqual({ jsonrpc: "2.0", id: 99, result: { ok: true } });
    rpc.close();
  });

  it("sends error response when reverse-request handler throws", async () => {
    const { client, server } = makeStreamPair();
    const rpc = new CodexRpc(client);
    rpc.onRequest("bomb", async () => { throw new Error("nope"); });
    const dec = new FrameDecoder();
    const responses: unknown[] = [];
    server.on("data", (chunk: Buffer) => {
      for (const msg of dec.push(chunk)) responses.push(msg);
    });
    server.push(encodeFrame({ jsonrpc: "2.0", id: 42, method: "bomb" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(responses[0]).toMatchObject({ id: 42, error: { message: "nope" } });
    rpc.close();
  });

  it("notifications() iterator yields incoming notifications", async () => {
    const { client, server } = makeStreamPair();
    const rpc = new CodexRpc(client);
    const iter = rpc.notifications();

    setTimeout(() => {
      server.push(encodeFrame({ jsonrpc: "2.0", method: "a", params: 1 }));
      server.push(encodeFrame({ jsonrpc: "2.0", method: "b", params: 2 }));
      setTimeout(() => rpc.close(), 20);
    }, 10);

    const received: Array<{ method: string; params: unknown }> = [];
    for await (const n of iter) received.push(n);
    expect(received).toEqual([
      { method: "a", params: 1 },
      { method: "b", params: 2 },
    ]);
  });
});
```

- [ ] **Step 2: Extend `CodexRpc` class**

Add these fields and methods to `CodexRpc`:

```ts
  // Add fields:
  private notificationHandlers = new Map<string, (params: unknown) => void>();
  private requestHandlers = new Map<string, (params: unknown) => Promise<unknown>>();
  private notifQueue: Array<{ method: string; params: unknown }> = [];
  private notifResolver: (() => void) | null = null;

  onNotification(method: string, handler: (params: unknown) => void): void {
    this.notificationHandlers.set(method, handler);
  }

  onRequest(method: string, handler: (params: unknown) => Promise<unknown>): void {
    this.requestHandlers.set(method, handler);
  }

  async *notifications(): AsyncIterableIterator<{ method: string; params: unknown }> {
    while (!this.closed || this.notifQueue.length > 0) {
      if (this.notifQueue.length > 0) {
        yield this.notifQueue.shift()!;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => { this.notifResolver = resolve; });
    }
  }

  // Override `dispatch`:
  protected dispatch(msg: object): void {
    const m = msg as {
      id?: number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { message?: string };
    };

    // Response to our request
    if (typeof m.id === "number" && this.pending.has(m.id)) {
      const pending = this.pending.get(m.id)!;
      this.pending.delete(m.id);
      if (m.error) pending.reject(new Error(m.error.message ?? "RPC error"));
      else pending.resolve(m.result);
      return;
    }

    // Server → client request (has id + method)
    if (typeof m.id === "number" && typeof m.method === "string") {
      const handler = this.requestHandlers.get(m.method);
      if (!handler) {
        this.stream.write(encodeFrame({
          jsonrpc: "2.0", id: m.id,
          error: { code: -32601, message: `Method not found: ${m.method}` },
        }));
        return;
      }
      handler(m.params)
        .then((result) => this.stream.write(encodeFrame({ jsonrpc: "2.0", id: m.id, result })))
        .catch((err: unknown) => this.stream.write(encodeFrame({
          jsonrpc: "2.0", id: m.id,
          error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
        })));
      return;
    }

    // Notification (no id)
    if (typeof m.method === "string") {
      const handler = this.notificationHandlers.get(m.method);
      if (handler) handler(m.params);
      this.notifQueue.push({ method: m.method, params: m.params });
      if (this.notifResolver) {
        const r = this.notifResolver;
        this.notifResolver = null;
        r();
      }
    }
  }

  // Update close() to also wake the notifications iterator:
  close(): void {
    this.closed = true;
    this.rejectAll(new Error("RPC closed"));
    if (this.notifResolver) {
      const r = this.notifResolver;
      this.notifResolver = null;
      r();
    }
    this.stream.end();
  }
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/agent/codex-rpc.test.ts`
Expected: all tests pass (previous + 4 new).

- [ ] **Step 4: Commit**

```bash
git add src/agent/codex-rpc.ts src/agent/codex-rpc.test.ts
git commit -m "feat(agent): add bidirectional RPC (notifications + reverse requests)"
```

---

### Task 11: Demo script — smoke test against real `codex app-server`

**Files:**
- Create: `scripts/codex-rpc-demo.mjs`

**Interfaces:**
- Consumes: `CodexRpc` (from built `dist/`)
- Produces: a manually-runnable script that verifies the RPC layer works against real codex

- [ ] **Step 1: Create the demo**

`scripts/codex-rpc-demo.mjs`:

```js
#!/usr/bin/env node
// Manual smoke test: connects to `codex app-server`, sends a "hello" turn,
// prints all agentMessage/delta events, exits when turn/completed.
//
// Run: node scripts/codex-rpc-demo.mjs
// Prereq: codex CLI installed and logged in.

import { spawn } from "node:child_process";
import { CodexRpc } from "../dist/agent/codex-rpc.js";

const proc = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "inherit"] });
const rpc = new CodexRpc(
  // Wrap stdin/stdout as a Duplex — for the demo we can pass proc.stdout as
  // read side and proc.stdin as write side by composing them:
  Object.assign(proc.stdout, {
    write: (chunk, enc, cb) => proc.stdin.write(chunk, enc, cb),
    end: () => proc.stdin.end(),
  }),
);

async function main() {
  console.log("[demo] initialize...");
  const init = await rpc.request("initialize", {
    clientInfo: { name: "claudecode-discord-demo", version: "0.0.1" },
    capabilities: {},
  });
  console.log("[demo] init result:", init);

  rpc.notify("initialized", {});

  console.log("[demo] thread/start...");
  const thread = await rpc.request("thread/start", {
    cwd: process.cwd(),
    sandbox: "read-only",
  });
  console.log("[demo] threadId:", thread.threadId);

  console.log("[demo] turn/start...");
  rpc.request("turn/start", {
    threadId: thread.threadId,
    input: [{ type: "text", text: "Say hello in one word." }],
  }).then(({ turnId }) => console.log("[demo] turnId:", turnId));

  for await (const notif of rpc.notifications()) {
    if (notif.method === "item/agentMessage/delta") {
      process.stdout.write(String(notif.params?.delta ?? ""));
    } else if (notif.method === "turn/completed") {
      console.log("\n[demo] turn complete");
      rpc.close();
      proc.kill();
      process.exit(0);
    }
  }
}

main().catch((err) => {
  console.error("[demo] error:", err);
  rpc.close();
  proc.kill();
  process.exit(1);
});
```

**Note on the Duplex wrapping:** the composition above is a hack. Cleaner approach: use `stream.Duplex.from` or write a small `duplex-pair` helper. Either way, verify via manual run.

- [ ] **Step 2: Build the project so dist/ is fresh**

Run: `npm run build`

- [ ] **Step 3: Run the demo**

Run: `node scripts/codex-rpc-demo.mjs`
Expected: sees "hello" (or whatever gpt-5 says) streamed to stdout, then `[demo] turn complete`, then exit 0.

**If it fails:** the codex app-server protocol may differ from what's assumed. Compare with `codex-companion.mjs` in `~/.claude/plugins/cache/openai-codex/` and adjust `CodexRpc` accordingly. This is Open Question #3 from the spec.

- [ ] **Step 4: Commit**

```bash
git add scripts/codex-rpc-demo.mjs
git commit -m "chore(agent): add codex-rpc demo script for manual verification"
```

**M2 milestone complete.** JSON-RPC client is production-ready and validated against real codex.

---

## Milestone 3 — CodexBackend + `/claude` `/codex` Commands

**Goal:** Wire CodexBackend into the factory, add DB column + slash commands + detection. After M3, users can switch backends per channel and both work end-to-end.

**M3 acceptance gate:** In Discord, `/codex` succeeds → send a message → codex runs it → tool approval buttons work → `/stop` interrupts → send another message → resumes the codex thread. `/claude` switches back. Existing Claude flows unaffected.

---

### Task 12: DB migration — `backend` column

**Files:**
- Modify: `src/db/database.ts` (migration + `setBackend` query)
- Modify: `src/db/types.ts` (`Project.backend` field)

**Interfaces:**
- Consumes: existing DB layer
- Produces: `setBackend(channelId: string, backend: "claude" | "codex"): void`; `Project.backend: "claude" | "codex"`

- [ ] **Step 1: Update `Project` type**

Edit `src/db/types.ts` — add to Project interface:
```ts
export interface Project {
  channel_id: string;
  project_path: string;
  guild_id: string;
  auto_approve: number;
  source_path: string | null;
  backend: "claude" | "codex";   // ← new
  created_at: string;
}
```

- [ ] **Step 2: Add migration in `initDatabase()`**

After the existing `source_path` migration block in `src/db/database.ts`, add:

```ts
if (!cols.some((c) => c.name === "backend")) {
  db.exec("ALTER TABLE projects ADD COLUMN backend TEXT NOT NULL DEFAULT 'claude'");
}
```

- [ ] **Step 3: Add `setBackend` query**

Append to `src/db/database.ts`:

```ts
export function setBackend(channelId: string, backend: "claude" | "codex"): void {
  db.prepare("UPDATE projects SET backend = ? WHERE channel_id = ?").run(backend, channelId);
}
```

- [ ] **Step 4: Verify compile**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Manually verify migration is idempotent**

Delete `data.db`, start the bot once (creates fresh), stop, start again (idempotent). Then simulate an old DB by running an older commit's `initDatabase`, then this commit's — should ALTER exactly once.

- [ ] **Step 6: Commit**

```bash
git add src/db/database.ts src/db/types.ts
git commit -m "feat(db): add projects.backend column with claude default"
```

---

### Task 13: `codex-detect` — three-stage check

**Files:**
- Create: `src/agent/codex-detect.ts`
- Create: `src/agent/codex-detect.test.ts`

**Interfaces:**
- Consumes: `L()` from `src/utils/i18n.js`
- Produces: `detectCodex(): Promise<{ ok: boolean; errorMessage: string }>`

- [ ] **Step 1: Write failing tests**

`src/agent/codex-detect.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  exec: vi.fn(),
}));

import { exec } from "node:child_process";
import { detectCodex, _clearCache } from "./codex-detect.js";

const mockExec = vi.mocked(exec);

function mockExecOnce(response: { stdout?: string; stderr?: string; code?: number; error?: Error }) {
  mockExec.mockImplementationOnce(((cmd: string, optsOrCb: unknown, maybeCb?: unknown) => {
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
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run src/agent/codex-detect.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `codex-detect`**

`src/agent/codex-detect.ts`:

```ts
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { L } from "../utils/i18n.js";

const execAsync = promisify(exec);

export interface CodexDetection {
  ok: boolean;
  errorMessage: string;
}

let cached: CodexDetection | null = null;

/** Test-only reset. */
export function _clearCache(): void {
  cached = null;
}

const INSTALL_HINT_EN =
  "❌ **Codex CLI not found.**\n\n" +
  "Install it first:\n```\nnpm install -g @openai/codex\n```\n" +
  "Or with Homebrew (macOS):\n```\nbrew install codex\n```\n" +
  "[Official install docs](https://github.com/openai/codex)";
const INSTALL_HINT_KR =
  "❌ **Codex CLI가 설치되어 있지 않습니다.**\n\n" +
  "먼저 설치하세요:\n```\nnpm install -g @openai/codex\n```\n" +
  "또는 Homebrew (macOS):\n```\nbrew install codex\n```\n" +
  "[공식 설치 문서](https://github.com/openai/codex)";

const RUN_FAIL_EN = "❌ Codex CLI is installed but not runnable. Try reinstalling.";
const RUN_FAIL_KR = "❌ Codex CLI가 실행되지 않습니다. 재설치를 시도하세요.";

const LOGIN_HINT_EN =
  "🔑 **Codex is not logged in.**\n\n" +
  "On the host PC, open a terminal and run:\n```\ncodex login\n```\n" +
  "Then try again. (Alternatively set `OPENAI_API_KEY` in .env)";
const LOGIN_HINT_KR =
  "🔑 **Codex 로그인이 필요합니다.**\n\n" +
  "호스트 PC에서 터미널을 열고 실행하세요:\n```\ncodex login\n```\n" +
  "그 후 다시 시도하세요. (또는 .env에 `OPENAI_API_KEY` 설정)";

export async function detectCodex(): Promise<CodexDetection> {
  if (cached) return cached;

  // Step 1: which
  try {
    const which = await execAsync("which codex");
    if (!which.stdout.trim()) throw new Error("empty");
  } catch {
    cached = { ok: false, errorMessage: L(INSTALL_HINT_EN, INSTALL_HINT_KR) };
    return cached;
  }

  // Step 2: --version
  try {
    const v = await execAsync("codex --version", { timeout: 5000 });
    if (!v.stdout.trim()) throw new Error("empty version");
  } catch {
    cached = { ok: false, errorMessage: L(RUN_FAIL_EN, RUN_FAIL_KR) };
    return cached;
  }

  // Step 3: auth (best-effort — codex auth status may not exist in all versions)
  try {
    const auth = await execAsync("codex auth status", { timeout: 5000 });
    if (/not logged in|unauthorized/i.test(auth.stderr ?? "") || /not logged in|unauthorized/i.test(auth.stdout ?? "")) {
      throw new Error("not logged in");
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // "command not found" style — auth subcommand missing in this codex version;
    // proceed anyway (M4 will refine this by trying thread/start as auth check).
    if (/unknown command|unrecognized subcommand/i.test(errMsg)) {
      // Silently pass — Open Question #2 tracks this refinement
    } else {
      cached = { ok: false, errorMessage: L(LOGIN_HINT_EN, LOGIN_HINT_KR) };
      return cached;
    }
  }

  cached = { ok: true, errorMessage: "" };
  return cached;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/agent/codex-detect.test.ts`
Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/agent/codex-detect.ts src/agent/codex-detect.test.ts
git commit -m "feat(agent): add codex-detect with three-stage check and caching"
```

---

### Task 14: Pure translator for codex JSON-RPC notifications

**Files:**
- Create: `src/agent/codex-translate.ts`
- Create: `src/agent/codex-translate.test.ts`

**Interfaces:**
- Consumes: `NormalizedEvent` (Task 1)
- Produces: `notificationToEvent(notif: { method: string; params: unknown }): NormalizedEvent | null`

**Note on codex event schema:** Based on the spec's Prior Art gist, notification methods include `item/started`, `item/completed`, `item/agentMessage/delta`, `item/reasoning/textDelta`, `turn/completed`. Exact `params` shapes need version-specific verification during implementation — this translator should be permissive (log-and-return-null for unknown shapes rather than crashing).

- [ ] **Step 1: Write failing tests**

`src/agent/codex-translate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { notificationToEvent } from "./codex-translate.js";

describe("notificationToEvent", () => {
  it("translates agentMessage/delta to text_delta", () => {
    const n = { method: "item/agentMessage/delta", params: { delta: "hello" } };
    expect(notificationToEvent(n)).toEqual({ type: "text_delta", text: "hello" });
  });

  it("translates reasoning/textDelta to text_delta with isReasoning", () => {
    const n = { method: "item/reasoning/textDelta", params: { delta: "thinking..." } };
    expect(notificationToEvent(n)).toEqual({ type: "text_delta", text: "thinking...", isReasoning: true });
  });

  it("translates item/started shell_command to tool_start", () => {
    const n = { method: "item/started", params: { item: { type: "shell_command", command: "ls" } } };
    expect(notificationToEvent(n)).toEqual({
      type: "tool_start",
      toolName: "Bash",
      input: { command: "ls" },
    });
  });

  it("translates item/started apply_patch to tool_start", () => {
    const n = { method: "item/started", params: { item: { type: "apply_patch", changes: [] } } };
    expect(notificationToEvent(n)).toMatchObject({ type: "tool_start", toolName: "Write" });
  });

  it("translates turn/completed success to result", () => {
    const n = { method: "turn/completed", params: { finalMessage: "done" } };
    expect(notificationToEvent(n)).toEqual({ type: "result", text: "done", isError: false });
  });

  it("translates turn/completed error to result with isError", () => {
    const n = { method: "turn/completed", params: { error: { message: "boom" } } };
    expect(notificationToEvent(n)).toMatchObject({ type: "result", isError: true, text: "boom" });
  });

  it("returns null for unknown method", () => {
    expect(notificationToEvent({ method: "item/mystery", params: {} })).toBeNull();
  });

  it("returns null for malformed params (does not throw)", () => {
    expect(notificationToEvent({ method: "item/agentMessage/delta", params: null })).toBeNull();
    expect(notificationToEvent({ method: "turn/completed", params: undefined })).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run src/agent/codex-translate.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement translator**

`src/agent/codex-translate.ts`:

```ts
import type { NormalizedEvent } from "./backend.js";

/**
 * Codex tool types → Discord-friendly tool names. Keep in sync with
 * SessionManager's toolLabels lookup so heartbeat activity strings render
 * consistently across backends.
 */
const CODEX_TOOL_TYPE_MAP: Record<string, string> = {
  shell_command: "Bash",
  apply_patch: "Write",
  mcp_tool_call: "MCP",
};

export function notificationToEvent(notif: { method: string; params: unknown }): NormalizedEvent | null {
  const { method, params } = notif;
  const p = params as Record<string, unknown> | null | undefined;

  if (method === "item/agentMessage/delta") {
    const delta = p && typeof p.delta === "string" ? p.delta : null;
    if (delta === null) return null;
    return { type: "text_delta", text: delta };
  }

  if (method === "item/reasoning/textDelta") {
    const delta = p && typeof p.delta === "string" ? p.delta : null;
    if (delta === null) return null;
    return { type: "text_delta", text: delta, isReasoning: true };
  }

  if (method === "item/started") {
    const item = p && (p.item as Record<string, unknown> | undefined);
    if (!item || typeof item.type !== "string") return null;
    const toolName = CODEX_TOOL_TYPE_MAP[item.type] ?? item.type;
    // Strip `type` and pass the rest as input
    const { type: _t, ...input } = item;
    return { type: "tool_start", toolName, input };
  }

  if (method === "turn/completed") {
    if (!p) return null;
    if (p.error) {
      const err = p.error as { message?: string };
      return { type: "result", text: err.message ?? "Task failed", isError: true };
    }
    const finalMessage = typeof p.finalMessage === "string" ? p.finalMessage : "Task completed";
    return { type: "result", text: finalMessage, isError: false };
  }

  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/agent/codex-translate.test.ts`
Expected: all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/agent/codex-translate.ts src/agent/codex-translate.test.ts
git commit -m "feat(agent): add pure translator for codex JSON-RPC notifications"
```

---

### Task 15: `CodexBackend` class

**Files:**
- Create: `src/agent/codex-backend.ts`
- Create: `src/agent/codex-backend.test.ts`

**Interfaces:**
- Consumes: `AgentBackend`, `NormalizedEvent`, `BackendStartOptions` (Task 1); `CodexRpc` (Tasks 8-10); `notificationToEvent` (Task 14); `detectCodex` (Task 13); `resolveWakeupDir` from `src/wakeup/paths.js`
- Produces: `CodexBackend` class implementing `AgentBackend`

- [ ] **Step 1: Write failing tests**

`src/agent/codex-backend.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { CodexBackend } from "./codex-backend.js";

describe("CodexBackend", () => {
  it("isResumeStaleError matches codex-specific error strings", () => {
    const b = new CodexBackend();
    expect(b.isResumeStaleError(new Error("thread not found"))).toBe(true);
    expect(b.isResumeStaleError(new Error("invalid threadId"))).toBe(true);
    expect(b.isResumeStaleError(new Error("some unrelated error"))).toBe(false);
  });

  it("getAuthErrorHint returns codex login hint for auth errors", () => {
    const b = new CodexBackend();
    expect(b.getAuthErrorHint(new Error("unauthorized"))).toContain("codex login");
    expect(b.getAuthErrorHint(new Error("401"))).toContain("codex login");
    expect(b.getAuthErrorHint(new Error("random"))).toBeNull();
  });

  it("interrupt() resolves pending approvals even if RPC is null", async () => {
    const b = new CodexBackend();
    let resolved = false;
    (b as unknown as { pendingApprovals: Map<string, (v: string) => void> })
      .pendingApprovals.set("x", (d) => { resolved = d === "deny"; });
    await b.interrupt();
    expect(resolved).toBe(true);
  });
});
```

- [ ] **Step 2: Implement `CodexBackend`**

`src/agent/codex-backend.ts`:

```ts
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Duplex } from "node:stream";
import { CodexRpc } from "./codex-rpc.js";
import { notificationToEvent } from "./codex-translate.js";
import { detectCodex } from "./codex-detect.js";
import { resolveWakeupDir } from "../wakeup/paths.js";
import type { AgentBackend, BackendStartOptions, NormalizedEvent } from "./backend.js";

const RESUME_STALE_PATTERNS = [
  /thread not found/i,
  /invalid threadId/i,
  /session not found/i,
];

const AUTH_KEYWORDS = ["unauthorized", "401", "not logged in", "authentication", "expired token"];

/**
 * Composes a Duplex from a spawned process's stdin (write side) and
 * stdout (read side). CodexRpc treats this as one stream.
 */
function processDuplex(proc: ChildProcessWithoutNullStreams): Duplex {
  return Duplex.from({
    readable: proc.stdout,
    writable: proc.stdin,
  });
}

export class CodexBackend implements AgentBackend {
  private rpc: CodexRpc | null = null;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private threadId: string | null = null;
  private turnId: string | null = null;
  private pendingApprovals = new Map<string, (decision: "allow" | "deny") => void>();
  private pendingQuestions = new Map<string, (answers: Record<string, string>) => void>();
  private eventQueue: NormalizedEvent[] = [];
  private eventResolver: (() => void) | null = null;

  private pushEvent(ev: NormalizedEvent): void {
    this.eventQueue.push(ev);
    if (this.eventResolver) {
      const r = this.eventResolver;
      this.eventResolver = null;
      r();
    }
  }

  async *start(opts: BackendStartOptions): AsyncIterableIterator<NormalizedEvent> {
    // Detection first
    const detect = await detectCodex();
    if (!detect.ok) {
      yield { type: "result", text: detect.errorMessage, isError: true };
      return;
    }

    // Spawn app-server
    this.proc = spawn("codex", ["app-server"], {
      cwd: opts.cwd,
      env: {
        ...process.env,
        WAKEUP_CHANNEL_ID: opts.channelId,
        WAKEUP_DIR: resolveWakeupDir(),
      },
      stdio: ["pipe", "pipe", "inherit"],
    });

    this.rpc = new CodexRpc(processDuplex(this.proc));

    // Register reverse-approval handlers BEFORE handshake so any early
    // approval requests get routed.
    this.rpc.onRequest("execCommandApproval", async (params) => {
      const p = params as { command?: string };
      const decision = await this.awaitApproval("Bash", { command: p.command ?? "" });
      return { decision: decision === "allow" ? "accept" : "decline" };
    });
    this.rpc.onRequest("applyPatchApproval", async (params) => {
      const p = params as { changes?: unknown };
      const decision = await this.awaitApproval("Write", { changes: p.changes });
      return { decision: decision === "allow" ? "accept" : "decline" };
    });

    // Handshake
    await this.rpc.request("initialize", {
      clientInfo: { name: "claudecode-discord", version: "1.0.0" },
      capabilities: {},
    });
    this.rpc.notify("initialized", {});

    // Start or resume thread.
    //
    // NOTE: opts.model is intentionally NOT forwarded to codex. Per spec
    // §6.2(d), codex reads its model from ~/.codex/config.toml. The
    // `model` field in BackendStartOptions is Claude-specific
    // (sourced from CLAUDE_MODEL env var); passing a Claude model string
    // like "claude-sonnet-4-5" to codex would fail.
    if (opts.resumeSessionId) {
      await this.rpc.request("thread/resume", { threadId: opts.resumeSessionId });
      this.threadId = opts.resumeSessionId;
    } else {
      // NOTE (Ruling R3): codex app-server returns `result.thread.id`,
      // NOT `result.threadId`. Empirically verified by scripts/codex-rpc-demo.mjs.
      const res = (await this.rpc.request("thread/start", {
        cwd: opts.cwd,
        sandbox: opts.skipPermissions ? "danger-full-access" : "workspace-write",
      })) as { thread: { id: string } };
      this.threadId = res.thread.id;
    }
    yield { type: "session_init", sessionId: this.threadId };

    // Start turn.
    // NOTE (Ruling R3): codex app-server returns `result.turn.id`,
    // NOT `result.turnId`. Empirically verified by scripts/codex-rpc-demo.mjs.
    const turnRes = (await this.rpc.request("turn/start", {
      threadId: this.threadId,
      input: [{ type: "text", text: opts.prompt }],
    })) as { turn: { id: string } };
    this.turnId = turnRes.turn.id;

    // Main loop: consume notifications + queued approval events
    const notifIter = this.rpc.notifications();
    let notifDone = false;
    (async () => {
      for await (const notif of notifIter) {
        const ev = notificationToEvent(notif);
        if (ev) this.pushEvent(ev);
      }
      notifDone = true;
      if (this.eventResolver) {
        const r = this.eventResolver;
        this.eventResolver = null;
        r();
      }
    })();

    while (true) {
      if (this.eventQueue.length > 0) {
        const ev = this.eventQueue.shift()!;
        yield ev;
        if (ev.type === "result") {
          this.cleanup();
          return;
        }
        continue;
      }
      if (notifDone) {
        this.cleanup();
        return;
      }
      await new Promise<void>((resolve) => { this.eventResolver = resolve; });
    }
  }

  private async awaitApproval(toolName: string, input: Record<string, unknown>): Promise<"allow" | "deny"> {
    const requestId = `codex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.pushEvent({ type: "tool_approval_request", requestId, toolName, input });
    return new Promise<"allow" | "deny">((resolve) => {
      this.pendingApprovals.set(requestId, resolve);
    });
  }

  private cleanup(): void {
    if (this.rpc) { try { this.rpc.close(); } catch { /* ignore */ } this.rpc = null; }
    if (this.proc) { try { this.proc.kill(); } catch { /* ignore */ } this.proc = null; }
    this.threadId = null;
    this.turnId = null;
  }

  async interrupt(): Promise<void> {
    if (this.rpc && this.threadId && this.turnId) {
      await Promise.race([
        this.rpc.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId }),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]).catch(() => {});
    }
    for (const [, resolve] of this.pendingApprovals) resolve("deny");
    this.pendingApprovals.clear();
    for (const [, resolve] of this.pendingQuestions) resolve({});
    this.pendingQuestions.clear();
    this.cleanup();
  }

  respondToApproval(requestId: string, decision: "allow" | "deny"): void {
    const resolver = this.pendingApprovals.get(requestId);
    if (!resolver) return;
    this.pendingApprovals.delete(requestId);
    resolver(decision);
  }

  respondToQuestion(_requestId: string, _answers: Record<string, string>): void {
    // Codex has no AskUserQuestion equivalent — no-op.
    // See M4 Task 20 for the warning UX when a Claude skill triggers it under codex.
  }

  isResumeStaleError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);
    return RESUME_STALE_PATTERNS.some((p) => p.test(msg));
  }

  getAuthErrorHint(error: unknown): string | null {
    const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
    if (AUTH_KEYWORDS.some((kw) => msg.includes(kw))) {
      return "🔑 Codex is not logged in. On the host PC, open a terminal and run `codex login`, then try again.";
    }
    return null;
  }
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/agent/codex-backend.test.ts`
Expected: 3 tests pass.

- [ ] **Step 4: Compile check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/agent/codex-backend.ts src/agent/codex-backend.test.ts
git commit -m "feat(agent): implement CodexBackend using app-server JSON-RPC"
```

---

### Task 16: Wire `backend-factory` to select by `project.backend`

**Files:**
- Modify: `src/agent/backend-factory.ts`

**Interfaces:**
- Consumes: `getProject` from `src/db/database.js`; `ClaudeBackend`, `CodexBackend`
- Produces: `getBackend(channelId)` routes correctly

- [ ] **Step 1: Update factory**

Replace contents of `src/agent/backend-factory.ts`:

```ts
import { getProject } from "../db/database.js";
import type { AgentBackend } from "./backend.js";
import { ClaudeBackend } from "./claude-backend.js";
import { CodexBackend } from "./codex-backend.js";

export function getBackend(channelId: string): AgentBackend {
  const project = getProject(channelId);
  if (project?.backend === "codex") return new CodexBackend();
  return new ClaudeBackend();
}
```

- [ ] **Step 2: Compile check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Run existing tests**

Run: `npm test`
Expected: everything green.

- [ ] **Step 4: Commit**

```bash
git add src/agent/backend-factory.ts
git commit -m "feat(agent): route backend selection by project.backend column"
```

---

### Task 17: `switch-backend` slash command factory

**Files:**
- Create: `src/bot/commands/switch-backend.ts`
- Create: `src/bot/commands/switch-backend.test.ts`

**Interfaces:**
- Consumes: `getProject`, `clearSessionId`, `setBackend` (from DB); `sessionManager` (from `src/claude/session-manager.js`); `detectCodex` (Task 13); `L()`
- Produces: `createSwitchBackendCommand(target: "claude" | "codex", displayName: string)` — returns `{ data, execute }` object for discord.js command registration

- [ ] **Step 1: Write failing tests**

`src/bot/commands/switch-backend.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db/database.js", () => ({
  getProject: vi.fn(),
  clearSessionId: vi.fn(),
  setBackend: vi.fn(),
}));
vi.mock("../../claude/session-manager.js", () => ({
  sessionManager: { isActive: vi.fn(() => false) },
}));
vi.mock("../../agent/codex-detect.js", () => ({
  detectCodex: vi.fn(async () => ({ ok: true, errorMessage: "" })),
}));

import { getProject } from "../../db/database.js";
import { sessionManager } from "../../claude/session-manager.js";
import { createSwitchBackendCommand } from "./switch-backend.js";

const mockGetProject = vi.mocked(getProject);
const mockIsActive = vi.mocked(sessionManager.isActive);

function makeInteraction(channelId = "ch1") {
  return {
    channelId,
    reply: vi.fn(async () => undefined),
  } as unknown as import("discord.js").ChatInputCommandInteraction;
}

describe("createSwitchBackendCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetProject.mockReset();
    mockIsActive.mockReset();
  });

  it("rejects when project is not registered", async () => {
    mockGetProject.mockReturnValue(undefined);
    const cmd = createSwitchBackendCommand("codex", "Codex");
    const inter = makeInteraction();
    await cmd.execute(inter);
    expect(inter.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("/register"), ephemeral: true }),
    );
  });

  it("reports no-op when already on target backend", async () => {
    mockGetProject.mockReturnValue({
      channel_id: "ch1", project_path: "/p", guild_id: "g", auto_approve: 0,
      source_path: null, backend: "codex", created_at: "",
    });
    const cmd = createSwitchBackendCommand("codex", "Codex");
    const inter = makeInteraction();
    await cmd.execute(inter);
    expect(inter.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("Already using") }),
    );
  });

  it("blocks switch when session is active", async () => {
    mockGetProject.mockReturnValue({
      channel_id: "ch1", project_path: "/p", guild_id: "g", auto_approve: 0,
      source_path: null, backend: "claude", created_at: "",
    });
    mockIsActive.mockReturnValue(true);
    const cmd = createSwitchBackendCommand("codex", "Codex");
    const inter = makeInteraction();
    await cmd.execute(inter);
    expect(inter.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("/stop") }),
    );
  });

  it("shows confirm buttons when switch is valid", async () => {
    mockGetProject.mockReturnValue({
      channel_id: "ch1", project_path: "/p", guild_id: "g", auto_approve: 0,
      source_path: null, backend: "claude", created_at: "",
    });
    mockIsActive.mockReturnValue(false);
    const cmd = createSwitchBackendCommand("codex", "Codex");
    const inter = makeInteraction();
    await cmd.execute(inter);
    const call = (inter.reply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.components).toBeDefined();
    expect(call.content).toContain("Continue?");
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run src/bot/commands/switch-backend.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement factory**

`src/bot/commands/switch-backend.ts`:

```ts
import {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ChatInputCommandInteraction,
} from "discord.js";
import { getProject } from "../../db/database.js";
import { sessionManager } from "../../claude/session-manager.js";
import { L } from "../../utils/i18n.js";

export function createSwitchBackendCommand(target: "claude" | "codex", displayName: string) {
  return {
    data: new SlashCommandBuilder()
      .setName(target)
      .setDescription(L(`Switch this channel to use ${displayName}`, `이 채널을 ${displayName}로 전환`)),

    async execute(interaction: ChatInputCommandInteraction): Promise<void> {
      const project = getProject(interaction.channelId);
      if (!project) {
        await interaction.reply({
          content: L("❌ Register a project first with /register", "❌ 먼저 /register로 프로젝트를 등록하세요"),
          ephemeral: true,
        });
        return;
      }

      if (project.backend === target) {
        await interaction.reply({
          content: L(`✅ Already using ${displayName} on this channel.`, `✅ 이미 ${displayName}를 사용 중입니다.`),
          ephemeral: true,
        });
        return;
      }

      if (sessionManager.isActive(interaction.channelId)) {
        await interaction.reply({
          content: L(
            `⚠️ A session is currently running. Use /stop first, then try /${target} again.`,
            `⚠️ 세션이 실행 중입니다. /stop 후 다시 /${target}를 시도하세요.`,
          ),
          ephemeral: true,
        });
        return;
      }

      const confirmBase = `switch-${target}-${interaction.channelId}`;
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`${confirmBase}-yes`)
          .setLabel(L("Yes, switch", "예, 전환"))
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`${confirmBase}-no`)
          .setLabel(L("Cancel", "취소"))
          .setStyle(ButtonStyle.Secondary),
      );
      const currentDisplay = project.backend === "claude" ? "Claude" : "Codex";
      await interaction.reply({
        content: L(
          `⚠️ Switching from **${currentDisplay}** to **${displayName}** will clear the existing ${currentDisplay} session on this channel. The old session file still exists on disk but this channel will no longer resume it. Continue?`,
          `⚠️ **${currentDisplay}**에서 **${displayName}**로 전환하면 이 채널의 기존 ${currentDisplay} 세션이 초기화됩니다. 세션 파일은 디스크에 남지만 이 채널에서는 더 이상 이어갈 수 없습니다. 계속할까요?`,
        ),
        components: [row],
        ephemeral: true,
      });
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/bot/commands/switch-backend.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/bot/commands/switch-backend.ts src/bot/commands/switch-backend.test.ts
git commit -m "feat(commands): add switch-backend factory for /claude and /codex"
```

---

### Task 18: `/claude` and `/codex` command files + register in client

**Files:**
- Create: `src/bot/commands/claude.ts`
- Create: `src/bot/commands/codex.ts`
- Modify: `src/bot/client.ts` (register both commands)

**Interfaces:**
- Consumes: `createSwitchBackendCommand` (Task 17)
- Produces: two ready-to-register discord.js command modules

- [ ] **Step 1: Create both command files**

`src/bot/commands/claude.ts`:
```ts
import { createSwitchBackendCommand } from "./switch-backend.js";
export default createSwitchBackendCommand("claude", "Claude");
```

`src/bot/commands/codex.ts`:
```ts
import { createSwitchBackendCommand } from "./switch-backend.js";
export default createSwitchBackendCommand("codex", "Codex");
```

- [ ] **Step 2: Register in `client.ts`**

Find the section in `src/bot/client.ts` where slash commands are registered (there should be an array or similar listing all commands). Add imports:

```ts
import claudeCommand from "./commands/claude.js";
import codexCommand from "./commands/codex.js";
```

Add `claudeCommand` and `codexCommand` to the registration list. The exact syntax depends on the existing pattern — copy how `register.ts` or `stop.ts` is wired.

- [ ] **Step 3: Compile check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Manual test**

Start bot, in a Discord channel:
- Type `/` — both `/claude` and `/codex` should appear in the dropdown
- Run `/register` first on a test channel
- Run `/claude` — should say "Already using Claude"
- Run `/codex` — should show confirmation buttons

- [ ] **Step 5: Commit**

```bash
git add src/bot/commands/claude.ts src/bot/commands/codex.ts src/bot/client.ts
git commit -m "feat(commands): register /claude and /codex slash commands"
```

---

### Task 19: Button handler for switch-backend confirmation

**Files:**
- Modify: `src/bot/handlers/interaction.ts`

**Interfaces:**
- Consumes: `clearSessionId`, `setBackend` (DB); `detectCodex` (Task 13); `L()`
- Produces: button handler for `switch-<target>-<channelId>-<yes|no>` custom IDs

- [ ] **Step 1: Add the handler**

Locate the existing button router in `src/bot/handlers/interaction.ts` (there's a section that handles button `customId` dispatch). Add a new case:

```ts
if (customId.startsWith("switch-claude-") || customId.startsWith("switch-codex-")) {
  // customId format: switch-<target>-<channelId>-<yes|no>
  const parts = customId.split("-");
  // parts = ["switch", target, ...channelIdParts, decision]
  // channelIds are Discord snowflakes (numeric) so no dash inside; but be defensive
  const target = parts[1] as "claude" | "codex";
  const decision = parts[parts.length - 1];
  const channelId = parts.slice(2, -1).join("-");

  if (decision === "no") {
    await interaction.update({ content: L("Cancelled.", "취소됨."), components: [] });
    return;
  }

  // decision === "yes"
  const { clearSessionId, setBackend } = await import("../../db/database.js");
  clearSessionId(channelId);
  setBackend(channelId, target);

  if (target === "codex") {
    const { detectCodex } = await import("../../agent/codex-detect.js");
    const detect = await detectCodex();
    if (!detect.ok) {
      await interaction.update({ content: detect.errorMessage, components: [] });
      return;
    }
  }

  const displayName = target === "claude" ? "Claude" : "Codex";
  await interaction.update({
    content: L(
      `✅ Switched to ${displayName}. Next message will start a fresh session.`,
      `✅ ${displayName}로 전환됨. 다음 메시지부터 새 세션을 시작합니다.`,
    ),
    components: [],
  });
  return;
}
```

**Note:** Static imports at top of file are preferred over dynamic `await import()`. Adjust based on existing file style — if the file uses static imports everywhere, hoist the imports.

- [ ] **Step 2: Compile check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Manual end-to-end test**

1. Start bot, run `/register` on a test channel
2. Run `/codex` → click "Yes, switch"
3. If codex is installed & logged in → success message; else → install/login hint
4. If success, send a message → verify codex runs it (should see different response style than Claude)
5. Approve a tool via button → verify decision is honored
6. `/stop` → verify session ends cleanly
7. Send another message → verify resume works
8. Run `/claude` → click "Yes, switch" → send a message → verify Claude runs it

- [ ] **Step 4: Commit**

```bash
git add src/bot/handlers/interaction.ts
git commit -m "feat(interaction): handle switch-backend confirmation buttons"
```

---

### Task 20: Update README + SETUP docs

**Files:**
- Modify: `README.md`, `README.kr.md`
- Modify: `SETUP.md`, `SETUP.kr.md` (if separate; else use README)

**Interfaces:** N/A — pure docs.

- [ ] **Step 1: Add `/claude` and `/codex` to the slash-command list in READMEs**

Find the existing slash-command reference table (usually under a "Commands" heading). Add:

| Command | Description |
|---|---|
| `/claude` | Switch this channel to use Claude Code backend |
| `/codex` | Switch this channel to use OpenAI Codex CLI backend |

- [ ] **Step 2: Add "Codex setup (optional)" section to SETUP.md and SETUP.kr.md**

Add a new section explaining:
- codex is optional; default backend is Claude
- Install: `npm install -g @openai/codex` or `brew install codex`
- Login: `codex login` (or `OPENAI_API_KEY` env var)
- Switch via `/codex` slash command per channel
- Note that switching backends clears the session (no history transfer)

- [ ] **Step 3: Commit**

```bash
git add README.md README.kr.md SETUP.md SETUP.kr.md
git commit -m "docs: document /claude and /codex backend switching"
```

**M3 milestone complete.** Users can switch backends per channel and both work end-to-end.

---

## Milestone 4 — Polish

**Goal:** Address rough edges surfaced in M3 dogfooding: cost display when codex doesn't report one, AskUserQuestion warning under codex, real e2e test.

---

### Task 21: Hide cost row when `costUsd` is undefined

**Files:**
- Modify: `src/claude/output-formatter.ts` (`createResultEmbed`)
- Modify: `src/claude/session-manager.ts` (pass `event.costUsd` through as optional, not `?? 0`)

**Interfaces:**
- No public API change; `createResultEmbed`'s `cost` parameter becomes `cost: number | undefined`.

- [ ] **Step 1: Update `createResultEmbed` signature**

Change the signature and add conditional:

```ts
export function createResultEmbed(
  text: string,
  cost: number | undefined,   // ← was `number`
  durationMs: number,
  showCost: boolean,
  isError: boolean,
): EmbedBuilder {
  // ...existing code...

  if (showCost && cost !== undefined) {
    embed.addFields({ name: "Cost", value: `$${cost.toFixed(4)}`, inline: true });
  }

  // ...
}
```

- [ ] **Step 2: Update SessionManager call site**

In `session-manager.ts`, change:
```ts
const resultEmbed = createResultEmbed(resultText, event.costUsd ?? 0, ..., isError);
```
to:
```ts
const resultEmbed = createResultEmbed(resultText, event.costUsd, ..., isError);
```

Also update the catch-block call (where `0` was passed as cost) — leave that as `undefined` if the error had no cost, or keep `0` if it did.

- [ ] **Step 3: Compile + test**

Run: `npx tsc --noEmit && npm test`
Expected: green.

- [ ] **Step 4: Manual verify**

Trigger a codex turn; verify the result embed does NOT show a "$0.0000" cost line. Trigger a Claude turn; verify cost shows as before.

- [ ] **Step 5: Commit**

```bash
git add src/claude/output-formatter.ts src/claude/session-manager.ts
git commit -m "feat(result-embed): hide cost row when backend does not report one"
```

---

### Task 22: `AskUserQuestion` warning under codex

**Files:**
- Modify: `src/claude/session-manager.ts` (add codex-detection in `ask_question_request` case)

**Interfaces:** No new interfaces. Behavior change: when the active backend is CodexBackend, `ask_question_request` emits a Discord warning and denies.

**Approach:** Check `project.backend` in the `ask_question_request` handler. If `"codex"`, send warning + `backend.respondToApproval(event.requestId, "deny")` (no need for a separate respondToQuestion path since codex won't ever emit ask_question_request itself — this only triggers if some abstraction bug slips through).

**Actually simpler:** Since only ClaudeBackend emits `ask_question_request` (CodexBackend's `respondToQuestion` is a no-op and it never emits), there's no runtime path where codex emits this. The task instead becomes: **document the invariant + add a defensive log-and-deny in CodexBackend if `respondToQuestion` is ever called**.

- [ ] **Step 1: Add defensive log in CodexBackend**

In `src/agent/codex-backend.ts`, update `respondToQuestion`:

```ts
respondToQuestion(requestId: string, _answers: Record<string, string>): void {
  console.warn(`[codex-backend] respondToQuestion called with requestId=${requestId} but codex does not support AskUserQuestion. Ignored.`);
}
```

- [ ] **Step 2: Add comment to `NormalizedEvent` union**

In `src/agent/backend.ts`, update the `ask_question_request` variant's docstring:

```ts
// AskUserQuestion — only Claude backend emits this. Codex has no
// equivalent; if a Claude-native skill triggers AskUserQuestion while
// running under codex (should not happen — skills are installed per-project),
// codex will ignore it.
| { type: "ask_question_request"; requestId: string; questions: AskQuestionData[] };
```

- [ ] **Step 3: Compile + test**

Run: `npx tsc --noEmit && npm test`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add src/agent/codex-backend.ts src/agent/backend.ts
git commit -m "docs(agent): document AskUserQuestion is Claude-only + defensive log"
```

---

### Task 23: Real codex end-to-end test (env-gated)

**Files:**
- Create: `src/agent/codex-backend.e2e.test.ts`

**Interfaces:**
- Consumes: `CodexBackend`
- Produces: an integration test that spawns real codex and verifies a full turn

- [ ] **Step 1: Write the test**

`src/agent/codex-backend.e2e.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { CodexBackend } from "./codex-backend.js";

const gate = process.env.CI_HAS_CODEX ? describe : describe.skip;

gate("CodexBackend end-to-end", () => {
  it("completes a hello-world turn", async () => {
    const backend = new CodexBackend();
    const events: string[] = [];
    let text = "";
    let sessionId: string | null = null;
    let didResult = false;

    for await (const ev of backend.start({
      prompt: "Reply with exactly the word: hello",
      cwd: process.cwd(),
      skipPermissions: true,
      channelId: "test-channel",
    })) {
      events.push(ev.type);
      if (ev.type === "session_init") sessionId = ev.sessionId;
      if (ev.type === "text_delta") text += ev.text;
      if (ev.type === "result") { didResult = true; break; }
    }

    expect(sessionId).toBeTruthy();
    expect(didResult).toBe(true);
    expect(text.toLowerCase()).toContain("hello");
    expect(events).toContain("session_init");
    expect(events).toContain("result");
  }, 60_000);
});
```

- [ ] **Step 2: Verify locally**

If your dev machine has codex installed & logged in:
```bash
CI_HAS_CODEX=1 npx vitest run src/agent/codex-backend.e2e.test.ts
```
Expected: passes within 60s.

If codex is not installed: the test suite skips this describe block entirely — no failure.

- [ ] **Step 3: Commit**

```bash
git add src/agent/codex-backend.e2e.test.ts
git commit -m "test(agent): add CodexBackend e2e test gated on CI_HAS_CODEX"
```

**M4 milestone complete.** Multi-agent backend feature is production-ready.

---

## Post-implementation checklist

After all 23 tasks:

- [ ] Run full test suite: `npm test`
- [ ] Run `npx tsc --noEmit` — zero errors
- [ ] Manual smoke test both backends in a real Discord channel
- [ ] Confirm `/register` on a fresh channel defaults to Claude
- [ ] Confirm `/codex` on a fresh channel walks through confirmation → detect → success
- [ ] Confirm switching back and forth preserves per-backend session_id on disk (Claude's `~/.claude/projects/` and codex's `~/.codex/sessions/` both survive)
- [ ] Update CHANGELOG or release notes (if the repo has one)

## Open questions (to resolve during implementation)

1. **Codex minimum version** — Task 13 (`codex-detect`) accepts any version. If specific versions lack app-server, add a min-version check.
2. **`codex auth status` exists?** — Task 13 tolerates missing subcommand silently. Verify what exists in current codex during Task 11 (demo script) and adjust.
3. **`codex-companion.mjs` reference path** — Task 11 mentions it as a protocol reference. Confirm exact path (`~/.claude/plugins/cache/openai-codex/...`) during that task.
4. **Reasoning delta display style** — Currently rendered same as text_delta. If distracting, add italics or spoiler wrapping in SessionManager's text_delta handler (Task 6).
5. **Version tag before M1 refactor** — Recommended: `git tag pre-multi-backend` before starting Task 6, for easy bisect if regression appears later.
