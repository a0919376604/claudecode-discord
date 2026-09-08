import { spawn, type ChildProcess } from "node:child_process";
import { Duplex, type Readable, type Writable } from "node:stream";
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
function processDuplex(stdout: Readable, stdin: Writable): Duplex {
  return Duplex.from({
    readable: stdout,
    writable: stdin,
  });
}

export class CodexBackend implements AgentBackend {
  private rpc: CodexRpc | null = null;
  private proc: ChildProcess | null = null;
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
    const proc = spawn("codex", ["app-server"], {
      cwd: opts.cwd,
      env: {
        ...process.env,
        WAKEUP_CHANNEL_ID: opts.channelId,
        WAKEUP_DIR: resolveWakeupDir(),
      },
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.proc = proc;

    this.rpc = new CodexRpc(processDuplex(proc.stdout as Readable, proc.stdin as Writable));

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

  respondToApproval(requestId: string, decision: "allow" | "deny", _message?: string): void {
    const resolver = this.pendingApprovals.get(requestId);
    if (!resolver) return;
    this.pendingApprovals.delete(requestId);
    resolver(decision);
  }

  respondToQuestion(requestId: string, _answers: Record<string, string>): void {
    console.warn(`[codex-backend] respondToQuestion called with requestId=${requestId} but codex does not support AskUserQuestion. Ignored.`);
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
