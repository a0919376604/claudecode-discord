import { describe, it, expect, vi } from "vitest";

// -----------------------------------------------------------------------------
// SDK mock — module-level so vi.mock hoisting works.
// Tests can grab `sdkController` after start() runs to feed the fake SDK.
// -----------------------------------------------------------------------------

interface SdkController {
  push: (message: unknown) => void;
  end: () => void;
  interrupt: ReturnType<typeof vi.fn>;
  capturedCanUseTool: ((toolName: string, input: Record<string, unknown>) => Promise<unknown>) | null;
}

const sdkController: SdkController = {
  push: () => { throw new Error("SDK not initialized"); },
  end: () => { throw new Error("SDK not initialized"); },
  interrupt: vi.fn(),
  capturedCanUseTool: null,
};

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  return {
    query: (opts: { options: { canUseTool?: (t: string, i: Record<string, unknown>) => Promise<unknown> } }) => {
      sdkController.capturedCanUseTool = opts.options.canUseTool ?? null;

      const queue: unknown[] = [];
      let resolver: (() => void) | null = null;
      let done = false;

      sdkController.push = (msg) => {
        queue.push(msg);
        if (resolver) { const r = resolver; resolver = null; r(); }
      };
      sdkController.end = () => {
        done = true;
        if (resolver) { const r = resolver; resolver = null; r(); }
      };
      sdkController.interrupt.mockClear();

      const iterator = {
        async next() {
          while (queue.length === 0 && !done) {
            await new Promise<void>((r) => { resolver = r; });
          }
          if (queue.length > 0) return { value: queue.shift()!, done: false };
          return { value: undefined, done: true };
        },
        [Symbol.asyncIterator]() { return iterator; },
        interrupt: sdkController.interrupt,
      };
      return iterator;
    },
  };
});

// Stub the credentials refresher — no macOS keychain during tests.
vi.mock("../claude/credentials-refresher.js", () => ({
  ensureFreshCredentials: vi.fn(async () => undefined),
}));

// Stub plugin registry + hook so start() doesn't touch bot internals.
vi.mock("../bot/client.js", () => ({
  pluginRegistry: { toSdkPluginConfig: () => ({}) },
  getDiscordClient: () => ({ channels: { cache: new Map() } }),
}));

vi.mock("../hooks/pre-tool-use.js", () => ({
  createPreToolUseHook: () => async () => ({ continue: true }),
}));

vi.mock("../wakeup/paths.js", () => ({
  resolveWakeupDir: () => "/tmp/test-wakeup-dir",
}));

// Only import ClaudeBackend AFTER mocks are declared (vi.mock is hoisted, so
// this actually runs before the mocks — the mocks are already registered).
import { ClaudeBackend } from "./claude-backend.js";
import type { BackendStartOptions, NormalizedEvent } from "./backend.js";

function makeStartOpts(): BackendStartOptions {
  return {
    prompt: "test",
    cwd: "/tmp",
    skipPermissions: false,
    channelId: "test-channel",
    // channel is required on the type but claude-backend passes it into the
    // hook builder (which we mocked into a no-op). Cast a lightweight stand-in.
    channel: {} as BackendStartOptions["channel"],
  };
}

describe("ClaudeBackend", () => {
  it("interrupt() resolves pending approvals as deny", async () => {
    const backend = new ClaudeBackend();
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

  // Regression test for the "options only appear after /stop" bug:
  //
  // Original bug: `start()`'s main for-await drained the eventQueue only
  // between SDK messages. When canUseTool blocked awaiting our decision,
  // no new SDK messages arrived, so ask_question_request / tool_approval_request
  // events sat stuck in the queue — the Discord embed never got sent until the
  // user pressed /stop, which forced canUseTool to unblock (via interrupt())
  // and let the SDK yield its next message, at which point the drain finally ran.
  //
  // Fix invariant: events pushed by canUseTool must reach the consumer
  // WHILE canUseTool is still blocked, so the consumer can send the Discord UI
  // and eventually call respondToQuestion / respondToApproval to unblock it.
  it("yields ask_question_request event WHILE canUseTool is blocked (regression: options-appear-only-after-stop)", async () => {
    const backend = new ClaudeBackend();
    const iter = backend.start(makeStartOpts());

    // Trigger a fake AskUserQuestion tool_use so canUseTool fires internally.
    // We do this ASAP, before the consumer starts pulling events — the SDK
    // yields the assistant message, then invokes canUseTool.
    setTimeout(() => {
      sdkController.push({ type: "system", subtype: "init", session_id: "sess-1" });
      sdkController.push({
        type: "assistant",
        content: [
          { type: "text", text: "Let me ask you something." },
          { type: "tool_use", name: "AskUserQuestion", input: { questions: [{ question: "Pick one?" }] } },
        ],
      });
      // The mocked SDK would normally invoke canUseTool here — do it manually
      // to simulate that path.
      setTimeout(() => {
        // canUseTool blocks awaiting our respondToQuestion. We must receive
        // the ask_question_request event BEFORE resolving it — that is the
        // whole point of this regression test.
        sdkController.capturedCanUseTool!(
          "AskUserQuestion",
          { questions: [{ question: "Pick one?" }] },
        ).then((decision) => {
          // After we respond, the SDK "processes the answer" and completes.
          void decision;
          sdkController.push({
            type: "result",
            subtype: "success",
            result: "done",
            total_cost_usd: 0,
          });
          sdkController.end();
        });
      }, 10);
    }, 10);

    // Consume until we see ask_question_request. If the bug is back, this
    // will time out because the event stays stuck in the queue.
    const events: NormalizedEvent[] = [];
    let askRequestId: string | null = null;

    const readerPromise = (async () => {
      for await (const ev of iter) {
        events.push(ev);
        if (ev.type === "ask_question_request") {
          askRequestId = ev.requestId;
          // Unblock canUseTool now that we've received the event.
          backend.respondToQuestion(ev.requestId, { "Pick one?": "A" });
        }
        if (ev.type === "result") break;
      }
    })();

    // Bounded wait — bug reproduction would hang until interrupt.
    await Promise.race([
      readerPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout: ask_question_request was not yielded while canUseTool was blocked (regression)")), 2000)),
    ]);

    expect(askRequestId).not.toBeNull();
    const askIdx = events.findIndex((e) => e.type === "ask_question_request");
    const resultIdx = events.findIndex((e) => e.type === "result");
    expect(askIdx).toBeGreaterThanOrEqual(0);
    expect(resultIdx).toBeGreaterThan(askIdx);
  });

  // Same invariant for the plain tool-approval path — a non-read-only tool
  // like Write also blocks canUseTool. The event must reach the consumer
  // before canUseTool's promise resolves.
  it("yields tool_approval_request event WHILE canUseTool is blocked", async () => {
    const backend = new ClaudeBackend();
    const iter = backend.start(makeStartOpts());

    setTimeout(() => {
      sdkController.push({ type: "system", subtype: "init", session_id: "sess-2" });
      setTimeout(() => {
        sdkController.capturedCanUseTool!(
          "Write",
          { file_path: "/tmp/foo.txt", content: "bar" },
        ).then(() => {
          sdkController.push({
            type: "result",
            subtype: "success",
            result: "wrote it",
            total_cost_usd: 0,
          });
          sdkController.end();
        });
      }, 10);
    }, 10);

    let approvalRequestId: string | null = null;
    const readerPromise = (async () => {
      for await (const ev of iter) {
        if (ev.type === "tool_approval_request") {
          approvalRequestId = ev.requestId;
          backend.respondToApproval(ev.requestId, "allow");
        }
        if (ev.type === "result") break;
      }
    })();

    await Promise.race([
      readerPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout: tool_approval_request was not yielded while canUseTool was blocked")), 2000)),
    ]);

    expect(approvalRequestId).not.toBeNull();
  });

  // Regression test for the "AskUserQuestion timeout hangs the session" bug:
  //
  // Session-manager routes question timeouts through `backend.respondToApproval(id, "deny", msg)`
  // (historical convention — session-manager uses one approval channel for both
  // approval buttons and question timeout). Before this fix, respondToApproval
  // only looked at pendingApprovals and silently no-oped when the id was a
  // question id. canUseTool then waited on the pendingQuestions promise
  // forever → session hung, user could only escape with /stop.
  //
  // Correct behavior (matches pre-refactor): timeout → canUseTool returns
  // {behavior: "deny", message: "Question timed out"} to the SDK. Claude sees
  // the tool as denied due to timeout and can move on.
  it("question timeout via respondToApproval(deny) makes canUseTool return deny (regression: timeout hangs)", async () => {
    const backend = new ClaudeBackend();
    const iter = backend.start(makeStartOpts());

    let canUseToolResult: { behavior: string; message?: string } | null = null;

    setTimeout(() => {
      sdkController.push({ type: "system", subtype: "init", session_id: "sess-3" });
      setTimeout(() => {
        // Simulate SDK invoking canUseTool for AskUserQuestion
        sdkController.capturedCanUseTool!(
          "AskUserQuestion",
          { questions: [{ question: "Pick one?" }] },
        ).then((decision) => {
          canUseToolResult = decision as { behavior: string; message?: string };
          // After canUseTool returns, the SDK would normally continue. In this
          // test we just push a synthetic result to let the generator finish.
          sdkController.push({
            type: "result",
            subtype: "success",
            result: "done",
            total_cost_usd: 0,
          });
          sdkController.end();
        });
      }, 10);
    }, 10);

    const readerPromise = (async () => {
      for await (const ev of iter) {
        if (ev.type === "ask_question_request") {
          // Simulate session-manager's timeout branch — it calls
          // respondToApproval("deny") with a message, NOT respondToQuestion.
          backend.respondToApproval(ev.requestId, "deny", "Question timed out");
        }
        if (ev.type === "result") break;
      }
    })();

    await Promise.race([
      readerPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout: canUseTool never returned after question denial (regression — respondToApproval no-oped on question id)")), 2000)),
    ]);

    expect(canUseToolResult).not.toBeNull();
    expect(canUseToolResult!.behavior).toBe("deny");
    expect(canUseToolResult!.message).toBe("Question timed out");
  });

  // Regression test for the "interrupt during pending question returns allow + empty answers" bug:
  //
  // interrupt() previously resolved pending questions with `{}`, so canUseTool
  // returned {behavior: "allow", updatedInput: {..., answers: {}}} — Claude
  // saw the tool as allowed with a blank answer, which is semantically wrong.
  // Fix: interrupt() resolves pending questions as denied so canUseTool
  // returns deny + "Interrupted".
  it("interrupt() during a pending question makes canUseTool return deny + Interrupted (regression)", async () => {
    const backend = new ClaudeBackend();
    const iter = backend.start(makeStartOpts());

    let canUseToolResult: { behavior: string; message?: string } | null = null;

    setTimeout(() => {
      sdkController.push({ type: "system", subtype: "init", session_id: "sess-4" });
      setTimeout(() => {
        sdkController.capturedCanUseTool!(
          "AskUserQuestion",
          { questions: [{ question: "Pick one?" }] },
        ).then((decision) => {
          canUseToolResult = decision as { behavior: string; message?: string };
          sdkController.push({
            type: "result",
            subtype: "success",
            result: "done",
            total_cost_usd: 0,
          });
          sdkController.end();
        });
      }, 10);
    }, 10);

    let askEventSeen = false;
    const readerPromise = (async () => {
      for await (const ev of iter) {
        if (ev.type === "ask_question_request") {
          askEventSeen = true;
          // Simulate /stop mid-question
          await backend.interrupt();
        }
        if (ev.type === "result") break;
      }
    })();

    await Promise.race([
      readerPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout: interrupt during pending question did not resolve canUseTool")), 2000)),
    ]);

    expect(askEventSeen).toBe(true);
    expect(canUseToolResult).not.toBeNull();
    expect(canUseToolResult!.behavior).toBe("deny");
    expect(canUseToolResult!.message).toBe("Interrupted");
  });
});
