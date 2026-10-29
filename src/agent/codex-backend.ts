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
  /** Accumulated assistant text for the current turn (reset on each turn/completed). */
  private currentAssistantText = "";
  private interrupted = false;
  private processExit: Promise<void> | null = null;

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
    if (this.interrupted) return;
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
    this.processExit = new Promise<void>(resolve => {
      proc.once("exit", () => resolve());
      proc.once("error", () => resolve());
    });

    try {
      const transport = processDuplex(proc.stdout as Readable, proc.stdin as Writable);
      this.rpc = new CodexRpc(transport);
      proc.on("error", (error) => transport.destroy(error));

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
      this.rpc.onRequest("item/commandExecution/requestApproval", async (params) => {
        const input = params as Record<string, unknown>;
        const decision = await this.awaitApproval("Bash", input);
        return { decision: decision === "allow" ? "accept" : "decline" };
      });
      this.rpc.onRequest("item/fileChange/requestApproval", async (params) => {
        const input = params as Record<string, unknown>;
        const decision = await this.awaitApproval("Write", input);
        return { decision: decision === "allow" ? "accept" : "decline" };
      });
      this.rpc.onRequest("mcpServer/elicitation/request", async (params) => {
        const input = params as { serverName?: string; message?: string };
        // Structured MCP forms/URL flows have no Discord UI yet. Cancel using
        // the protocol response rather than returning Method not found, and
        // explain the limitation so the user can continue in a native client.
        this.pushEvent({
          type: "text_delta",
          text: `\n⚠️ MCP ${input.serverName ?? "server"} requested input that this Discord bot cannot collect yet. The request was cancelled; continue this step in Codex.\n${input.message ?? ""}\n`,
        });
        return { action: "cancel", content: null };
      });

      // Handshake
      await this.rpc.request("initialize", {
        clientInfo: { name: "claudecode-discord", version: "1.0.0" },
        capabilities: {},
      });
      if (this.interrupted) return;
      this.rpc.notify("initialized", {});

      // Start or resume thread.
      //
      // SessionManager supplies the independent Codex override, never CLAUDE_MODEL.
      const modelOverride = opts.model ? { model: opts.model } : {};
      let threadResponse: { model?: string };
      if (opts.resumeSessionId) {
        threadResponse = await this.rpc.request("thread/resume", { threadId: opts.resumeSessionId, ...modelOverride }) as { model?: string };
        this.threadId = opts.resumeSessionId;
      } else {
        // NOTE (Ruling R3): codex app-server returns `result.thread.id`,
        // NOT `result.threadId`. Empirically verified by scripts/codex-rpc-demo.mjs.
        const res = (await this.rpc.request("thread/start", {
          cwd: opts.cwd,
          sandbox: opts.skipPermissions ? "danger-full-access" : "workspace-write",
          ...modelOverride,
        })) as { thread: { id: string }; model?: string };
        this.threadId = res.thread.id;
        threadResponse = res;
      }
      if (this.interrupted) return;
      yield { type: "session_init", sessionId: this.threadId, model: threadResponse.model };
      if (this.interrupted) return;

      // Start turn.
      // NOTE (Ruling R3): codex app-server returns `result.turn.id`,
      // NOT `result.turnId`. Empirically verified by scripts/codex-rpc-demo.mjs.
      const turnRes = (await this.rpc.request("turn/start", {
        threadId: this.threadId,
        input: [{ type: "text", text: opts.prompt }],
        ...modelOverride,
      })) as { turn: { id: string } };
      this.turnId = turnRes.turn.id;

      // Main loop: consume notifications + queued approval events
      const notifIter = this.rpc.notifications();
      let notifDone = false;
      void (async () => {
        try {
          for await (const notif of notifIter) {
            // app-server also broadcasts subagent events. A child's completion
            // must never end the parent iterator (whose finally kills app-server).
            const params = notif.params as Record<string, unknown> | null | undefined;
            const turn = params?.turn as { id?: unknown } | null | undefined;
            const eventTurnId = params?.turnId ?? turn?.id;
            if (typeof params?.threadId === "string" && params.threadId !== this.threadId) continue;
            if (typeof eventTurnId === "string" && eventTurnId !== this.turnId) continue;
            // Terminal events must identify BOTH the owning thread and turn.
            // Reject malformed/unscoped completion rather than kill live work.
            if (notif.method === "turn/completed" &&
                (params?.threadId !== this.threadId || turn?.id !== this.turnId)) continue;

            // Accumulate assistant text so we can attach it to turn/completed.
            if (notif.method === "item/agentMessage/delta") {
              if (params && typeof params.delta === "string") {
                this.currentAssistantText += params.delta;
              }
            }
            const ev = notif.method === "turn/completed"
              ? notificationToEvent(notif, this.currentAssistantText)
              : notificationToEvent(notif);
            if (ev) {
              if (ev.type === "result") this.currentAssistantText = "";
              this.pushEvent(ev);
            }
          }
        } catch (error) {
          this.pushEvent({ type: "result", text: error instanceof Error ? error.message : String(error), isError: true });
        } finally {
          notifDone = true;
          if (this.eventResolver) {
            const r = this.eventResolver;
            this.eventResolver = null;
            r();
          }
        }
      })();

      while (true) {
        if (this.eventQueue.length > 0) {
          const ev = this.eventQueue.shift()!;
          yield ev;
          if (ev.type === "result") {
            return;
          }
          continue;
        }
        if (notifDone) {
          return;
        }
        await new Promise<void>((resolve) => { this.eventResolver = resolve; });
      }
    } finally {
      this.cleanup();
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
    for (const resolve of this.pendingApprovals.values()) resolve("deny");
    this.pendingApprovals.clear();
    for (const resolve of this.pendingQuestions.values()) resolve({});
    this.pendingQuestions.clear();
    if (this.rpc) { try { this.rpc.close(); } catch { /* ignore */ } this.rpc = null; }
    if (this.proc) { try { this.proc.kill(); } catch { /* ignore */ } this.proc = null; }
    this.threadId = null;
    this.turnId = null;
    this.currentAssistantText = "";
    this.eventQueue = [];
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
    const proc = this.proc;
    const processExit = this.processExit;
    if (this.rpc && this.threadId && this.turnId) {
      await this.waitBriefly(this.rpc.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId }).then(() => {}).catch(() => {}));
    }
    for (const [, resolve] of this.pendingApprovals) resolve("deny");
    this.pendingApprovals.clear();
    for (const [, resolve] of this.pendingQuestions) resolve({});
    this.pendingQuestions.clear();
    this.cleanup();
    if (proc && processExit) {
      if (!await this.waitBriefly(processExit)) proc.kill("SIGKILL");
      // Sending a signal is not confirmation. Keep the task stopping until exit.
      await processExit;
    }
  }

  private async waitBriefly(promise: Promise<void>): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([promise.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 3000); })]);
    } finally { if (timer) clearTimeout(timer); }
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
