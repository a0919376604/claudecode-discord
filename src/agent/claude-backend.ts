import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pluginRegistry } from "../bot/client.js";
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
            hooks: [createPreToolUseHook({
              channelId: opts.channelId,
              channel: opts.channel,
              now: () => Date.now(),
            })],
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

