import { describe, it, expect, vi, beforeEach } from "vitest";
import { getProject } from "../db/database.js";
import { notificationToEvent } from "../agent/codex-translate.js";
import { translateDeepTutorEvent } from "../agent/deeptutor-translate.js";
import { MockAgentBackend } from "../agent/mock-backend.js";

// ─── Module mocks (hoisted by vitest) ───────────────────────────────────────

// Mock the factory to return our test backend
const testBackend = new MockAgentBackend();
vi.mock("../agent/backend-factory.js", () => ({
  getBackend: () => testBackend,
}));

// Mock DB layer — sessions and projects
vi.mock("../db/database.js", () => ({
  getProject: vi.fn(() => ({
    channel_id: "ch1",
    project_path: "/tmp/proj",
    guild_id: "g1",
    auto_approve: 0,
    source_path: null,
    backend: "claude",
    created_at: "",
  })),
  getSession: vi.fn(() => undefined),
  upsertSession: vi.fn(),
  updateSessionStatus: vi.fn(),
  setLastModel: vi.fn(),
  setAutoApprove: vi.fn(),
}));

// Mock config — avoid real env-var validation
vi.mock("../utils/config.js", () => ({
  getConfig: () => ({
    SHOW_COST: false,
    CLAUDE_MODEL: undefined,
    MAX_SESSION_DURATION_MIN: 0,
  }),
}));

// Mock i18n — use English strings in tests
vi.mock("../utils/i18n.js", () => ({
  L: (en: string, _kr: string) => en,
}));

// Mock skip-permissions — default false
vi.mock("../utils/skip-permissions.js", () => ({
  isSkipPermissionsEnabled: () => false,
}));

// Mock wakeup queue — avoid real DB access in finally block
vi.mock("../wakeup/queue.js", () => ({
  drainOldest: vi.fn(() => null),
}));

// Mock wakeup paths — avoid filesystem access
vi.mock("../wakeup/paths.js", () => ({
  resolveWakeupDir: vi.fn(() => "/tmp/test-wakeup-dir"),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeMockChannel() {
  const messages: Array<{ id: string; content: string; embeds?: unknown[]; components?: unknown[] }> = [];
  let id = 0;
  const makeMessage = (content: string, extras?: Record<string, unknown>) => {
    const msg: Record<string, unknown> = {
      id: `msg-${++id}`,
      content,
      ...extras,
    };
    msg.edit = vi.fn(async (patch: unknown) => Object.assign(msg, typeof patch === "string" ? { content: patch } : patch));
    msg.delete = vi.fn(async () => {});
    messages.push(msg as { id: string; content: string; embeds?: unknown[]; components?: unknown[] });
    return msg;
  };
  return {
    id: "ch1",
    messages,
    send: vi.fn(async (payload: string | { content?: string; embeds?: unknown[]; components?: unknown[] }) => {
      if (typeof payload === "string") return makeMessage(payload);
      return makeMessage(payload.content ?? "", payload as Record<string, unknown>);
    }),
  } as unknown as import("discord.js").TextChannel;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("SessionManager with MockAgentBackend", () => {
  beforeEach(() => {
    // Reset backend state between tests by reassigning all tracked fields
    const fresh = new MockAgentBackend();
    Object.assign(testBackend, {
      lastStartOptions: fresh.lastStartOptions,
      interruptCalled: fresh.interruptCalled,
      approvalResponses: fresh.approvalResponses,
      questionResponses: fresh.questionResponses,
    });
    // Reset internal queues via the fresh instance's private fields —
    // cast through any to reach them
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b = testBackend as any;
    b.events = [];
    b.resolvers = [];
    b.ended = false;
    b.pendingApprovals = new Map();
    b.pendingQuestions = new Map();
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

  it("joins Codex token deltas without inserting paragraph breaks", async () => {
    const { sessionManager } = await import("./session-manager.js");
    const project = getProject("ch1")!;
    vi.mocked(getProject).mockReturnValueOnce({ ...project, backend: "codex" });
    const channel = makeMockChannel();
    for (const delta of ["修", "好了", "，", "這是正常", "排版。\n", "第二行"]) {
      testBackend.enqueueEvent(notificationToEvent({ method: "item/agentMessage/delta", params: { delta } })!);
    }
    testBackend.enqueueEvent({ type: "result", text: "", isError: false });
    testBackend.endStream();
    await sessionManager.sendMessage(channel, "test prompt");
    const messages = (channel as unknown as { messages: Array<{ content: string }> }).messages;
    expect(messages[1].content).toBe("修好了，這是正常排版。\n第二行");
    expect(messages[0].content).toBe("");
  });

  it("passes the channel /model and /effort overrides to the DeepTutor backend", async () => {
    const { sessionManager } = await import("./session-manager.js");
    vi.mocked(getProject).mockReturnValueOnce({ ...getProject("ch1")!, backend: "deeptutor", model: "opus", effort: "high" });
    testBackend.enqueueEvent({ type: "result", text: "", isError: false });
    testBackend.endStream();
    await sessionManager.sendMessage(makeMockChannel(), "daily push");
    expect(testBackend.lastStartOptions?.model).toBe("opus");
    expect(testBackend.lastStartOptions?.effort).toBe("high");
  });

  it("renders DeepTutor token deltas as prose followed by a separate question card", async () => {
    const { sessionManager } = await import("./session-manager.js");
    vi.mocked(getProject).mockReturnValueOnce({ ...getProject("ch1")!, backend: "deeptutor" });
    const channel = makeMockChannel();
    for (const content of ["Hel", "lo", " world"]) {
      for (const event of translateDeepTutorEvent({ type: "content", content })) testBackend.enqueueEvent(event);
    }
    for (const event of translateDeepTutorEvent({
      type: "tool_result", metadata: { tool: "mastery_quiz", tool_metadata: { mastery_question: { prompt: "Pick", options: [{ label: "A", body: "large" }] } } },
    })) testBackend.enqueueEvent(event);
    testBackend.enqueueEvent({ type: "result", text: "", isError: false });
    testBackend.endStream();
    await sessionManager.sendMessage(channel, "daily push");
    const messages = (channel as unknown as { messages: Array<{ content: string }> }).messages;
    expect(messages.map(m => m.content).filter(Boolean).join("")).toBe("Hello world\n\n📝 Pick\nA. large\n↩️ Reply with your answer in this channel");
  });

  it("shows the effective Codex model in progress and the result footer", async () => {
    const { sessionManager } = await import("./session-manager.js");
    vi.mocked(getProject).mockReturnValueOnce({ ...getProject("ch1")!, backend: "codex" });
    const channel = makeMockChannel();
    testBackend.enqueueEvent({ type: "session_init", sessionId: "codex-1", model: "actual-codex-model" });
    const done = sessionManager.sendMessage(channel, "hello");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const messages = (channel as unknown as { messages: Array<{ content: string; embeds?: Array<{ toJSON(): { footer?: { text: string } } }> }> }).messages;
    expect(JSON.stringify(messages[0].embeds)).toContain("actual-codex-model");
    testBackend.enqueueEvent({ type: "result", text: "done", isError: false });
    testBackend.endStream();
    await done;
    expect(messages.filter(m => m.embeds?.length)).toHaveLength(1);
    expect(JSON.stringify(messages[0].embeds)).toContain("actual-codex-model");
  });

  it("keeps Codex reasoning out of the assistant answer", async () => {
    const { sessionManager } = await import("./session-manager.js");
    vi.mocked(getProject).mockReturnValueOnce({ ...getProject("ch1")!, backend: "codex" });
    const channel = makeMockChannel();
    testBackend.enqueueEvent({ type: "text_delta", text: "internal reasoning", isReasoning: true });
    testBackend.enqueueEvent({ type: "text_delta", text: "Actual answer" });
    testBackend.enqueueEvent({ type: "result", text: "", isError: false });
    testBackend.endStream();
    await sessionManager.sendMessage(channel, "hello");
    const messages = (channel as unknown as { messages: Array<{ content: string }> }).messages;
    expect(messages[1].content).toBe("Actual answer");
    expect(JSON.stringify(messages)).not.toContain("internal reasoning");
  });

  it("shows Codex tool details after commentary, coalesces updates, and reports failure", async () => {
    vi.useFakeTimers();
    try {
      const { sessionManager } = await import("./session-manager.js");
      vi.mocked(getProject).mockReturnValueOnce({ ...getProject("ch1")!, backend: "codex" });
      const channel = makeMockChannel();
      testBackend.enqueueEvent({ type: "text_delta", text: "I will run tests." });
      testBackend.enqueueEvent(notificationToEvent({ method: "item/started", params: { item: {
        type: "commandExecution", id: "cmd-1", command: "npm test",
      } } })!);
      const done = sessionManager.sendMessage(channel, "test");
      await vi.advanceTimersByTimeAsync(1600);
      const messages = (channel as unknown as { messages: Array<{ content: string; edit: ReturnType<typeof vi.fn> }> }).messages;
      const progress = messages[0];
      expect(progress).toBeDefined();
      expect(JSON.stringify(progress)).toContain("npm test");
      expect(messages[1].content).toBe("I will run tests.");
      const edits = progress!.edit.mock.calls.length;
      for (let i = 0; i < 5; i++) {
        testBackend.enqueueEvent({ type: "tool_start", toolName: "Bash", input: { id: `cmd-${i + 2}`, command: "npm test" } });
      }
      await vi.advanceTimersByTimeAsync(100);
      expect(progress!.edit.mock.calls.length - edits).toBeLessThanOrEqual(1);
      testBackend.enqueueEvent(notificationToEvent({ method: "item/completed", params: { item: {
        type: "commandExecution", id: "cmd-6", command: "npm test", status: "failed", exitCode: 1,
      } } })!);
      testBackend.enqueueEvent({ type: "result", text: "Tests failed", isError: false });
      testBackend.endStream();
      await vi.advanceTimersByTimeAsync(10);
      await done;
      const runId = JSON.stringify(progress).match(/card-details:([a-f0-9-]+)/)![1];
      expect(sessionManager.getTaskCard("ch1", runId)?.details()).toContain("❌");
      expect(sessionManager.getTaskCard("ch1", runId)?.details()).toContain("npm test");
      expect(JSON.stringify(progress)).toContain("6 tool calls");
      expect(messages).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });

  it("includes tool counts even when a Codex turn finishes before its progress timer fires", async () => {
    const { sessionManager } = await import("./session-manager.js");
    vi.mocked(getProject).mockReturnValueOnce({ ...getProject("ch1")!, backend: "codex" });
    const channel = makeMockChannel();
    testBackend.enqueueEvent({ type: "session_init", sessionId: "c-1", model: "codex-model" });
    testBackend.enqueueEvent({ type: "tool_start", toolName: "Bash", input: { command: "npm test" } });
    testBackend.enqueueEvent({ type: "result", text: "done", isError: false });
    testBackend.endStream();
    await sessionManager.sendMessage(channel, "test");
    const messages = (channel as unknown as { messages: Array<{ embeds?: Array<{ toJSON(): { footer?: { text: string } } }> }> }).messages;
    const footer = messages.find(m => m.embeds?.length)?.embeds?.[0].toJSON().footer?.text;
    expect(footer).toContain("1 tool calls");
    expect(JSON.stringify(messages[0])).toContain("codex-model");
  });

  it("isolates Codex model preferences from Claude and expires old controls", async () => {
    const { sessionManager } = await import("./session-manager.js");
    vi.mocked(getProject).mockReturnValueOnce({ ...getProject("ch1")!, backend: "codex", model: "opus", codex_model: "gpt-6.1-sol" });
    const channel = makeMockChannel();
    testBackend.enqueueEvent({ type: "result", text: "Connection lost", isError: true });
    testBackend.endStream();
    await sessionManager.sendMessage(channel, "Add feature");
    expect(testBackend.lastStartOptions?.model).toBe("gpt-6.1-sol");
    const messages = (channel as unknown as { messages: unknown[] }).messages;
    const runId = JSON.stringify(messages[0]).match(/card-details:([a-f0-9-]+)/)![1];
    expect(sessionManager.getTaskCard("ch1", runId)?.phase).toBe("failed");
    expect(sessionManager.getTaskCard("other", runId)).toBeUndefined();
    expect(await sessionManager.stopTask("ch1", "stale")).toBe(false);
    expect(testBackend.interruptCalled).toBe(0);
    vi.mocked(getProject).mockReturnValueOnce({ ...getProject("ch1")!, backend: "codex" });
    await sessionManager.sendMessage(channel, "New task");
    expect(testBackend.lastStartOptions?.model).toBeUndefined();
    expect(sessionManager.getTaskCard("ch1", runId)).toBeUndefined();
    expect(await sessionManager.recoverTask(channel, runId)).toBe(false);
  });

  it("keeps a stopping card active until the backend confirms interruption", async () => {
    const { sessionManager } = await import("./session-manager.js");
    vi.mocked(getProject).mockReturnValueOnce({ ...getProject("ch1")!, backend: "codex" });
    const channel = makeMockChannel();
    const running = sessionManager.sendMessage(channel, "Run tests");
    await new Promise(resolve => setTimeout(resolve, 5));
    const runId = JSON.stringify((channel as unknown as { messages: unknown[] }).messages[0]).match(/card-details:([a-f0-9-]+)/)![1];
    let acknowledge!: () => void;
    const interrupt = vi.spyOn(testBackend, "interrupt").mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { acknowledge = resolve; });
      testBackend.endStream();
    });
    const stopping = sessionManager.stopTask("ch1", runId);
    expect(sessionManager.getTaskCard("ch1", runId)?.phase).toBe("stopping");
    expect(sessionManager.isActive("ch1")).toBe(true);
    acknowledge();
    await stopping;
    await running;
    expect(sessionManager.getTaskCard("ch1", runId)?.phase).toBe("stopped");
    expect(sessionManager.isActive("ch1")).toBe(false);
    interrupt.mockRestore();
  });

  it("recovers once by inspecting existing work before continuing", async () => {
    const { sessionManager } = await import("./session-manager.js");
    const project = { ...getProject("ch1")!, backend: "codex" as const };
    vi.mocked(getProject).mockReturnValueOnce(project);
    const channel = makeMockChannel();
    testBackend.enqueueEvent({ type: "result", text: "Disconnected", isError: true });
    testBackend.endStream();
    await sessionManager.sendMessage(channel, "Add model setting");
    const runId = JSON.stringify((channel as unknown as { messages: unknown[] }).messages[0]).match(/card-details:([a-f0-9-]+)/)![1];
    vi.mocked(getProject).mockReturnValueOnce(project).mockReturnValueOnce(project).mockReturnValueOnce(project);
    const first = sessionManager.recoverTask(channel, runId);
    const duplicate = sessionManager.recoverTask(channel, runId);
    expect(await first).toBe(true);
    expect(await duplicate).toBe(false);
    expect(testBackend.lastStartOptions?.prompt).toContain("First inspect the current worktree");
    expect(testBackend.lastStartOptions?.prompt).toContain("Original request:\nAdd model setting");
  });

  it.each([false, true])("stopping cancels local question waits, custom input, and later questions (send pending=%s)", async holdSend => {
    const { sessionManager } = await import("./session-manager.js");
    const project = { ...getProject("ch1")!, backend: "codex" as const };
    vi.mocked(getProject).mockReturnValueOnce(project);
    const channel = makeMockChannel();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const send = channel.send as ReturnType<typeof vi.fn>;
    const originalSend = send.getMockImplementation()!;
    send.mockImplementation(async payload => {
      const message = await originalSend(payload);
      if (holdSend && JSON.stringify(payload).includes("ask-opt:")) await gate;
      return message;
    });
    const question = { question: "Pick?", header: "Pick", options: [{ label: "A", description: "A" }], multiSelect: false };
    testBackend.enqueueEvent({ type: "ask_question_request", requestId: "question", questions: [question, { ...question, question: "Second question?" }] });
    const running = sessionManager.sendMessage(channel, "Add feature");
    await new Promise(resolve => setTimeout(resolve, 10));
    const messages = (channel as unknown as { messages: unknown[] }).messages;
    const runId = JSON.stringify(messages[0]).match(/card-details:([a-f0-9-]+)/)![1];
    const questionId = JSON.stringify(messages[1]).match(/ask-opt:([a-f0-9-]+):/)![1];
    if (!holdSend) sessionManager.enableCustomInput(questionId, "ch1");
    try {
      const stopping = sessionManager.stopTask("ch1", runId);
      release();
      await stopping;
      expect(sessionManager.isActive("ch1")).toBe(false);
      expect(sessionManager.hasPendingCustomInput("ch1")).toBe(false);
      expect(sessionManager.resolveQuestion(questionId, "A")).toBe(false);
      expect(testBackend.questionResponses).toHaveLength(0);
      expect(messages).toHaveLength(2);
      expect(JSON.stringify(messages[1])).not.toContain("ask-opt:");
      vi.mocked(getProject).mockReturnValueOnce(project).mockReturnValueOnce(project);
      expect(await sessionManager.recoverTask(channel, runId)).toBe(true);
    } finally {
      release();
      // Also release both questions on the RED path, so a failed assertion
      // does not leave the test waiting for the production five-minute timeout.
      for (let i = 0; i < 3; i++) {
        await new Promise(resolve => setTimeout(resolve, 0));
        for (const message of messages) {
          const id = JSON.stringify(message).match(/ask-opt:([a-f0-9-]+):/)?.[1];
          if (id) sessionManager.resolveQuestion(id, "A");
        }
      }
      await running;
    }
  });

  it("keeps paragraph breaks between complete Claude text blocks", async () => {
    const { sessionManager } = await import("./session-manager.js");
    const channel = makeMockChannel();
    testBackend.enqueueEvent({ type: "text_delta", text: "First paragraph." });
    testBackend.enqueueEvent({ type: "text_delta", text: "Second paragraph." });
    testBackend.enqueueEvent({ type: "result", text: "", isError: false });
    testBackend.endStream();
    await sessionManager.sendMessage(channel, "test prompt");
    const messages = (channel as unknown as { messages: Array<{ content: string }> }).messages;
    expect(messages[0].content).toBe("First paragraph.\n\nSecond paragraph.");
  });

  it("replaces the progress message when text resumes instead of stacking Stop buttons", async () => {
    vi.useFakeTimers();
    try {
      const { sessionManager } = await import("./session-manager.js");
      const channel = makeMockChannel();
      testBackend.enqueueEvent({ type: "session_init", sessionId: "sess-1" });
      testBackend.enqueueEvent({ type: "text_delta", text: "first" });
      const done = sessionManager.sendMessage(channel, "test prompt");

      // Silent > 30s stale threshold → heartbeat posts a "⏳ … [Stop]" message.
      await vi.advanceTimersByTimeAsync(46_000);
      const msgs = (channel as unknown as { messages: Array<Record<string, unknown>> }).messages;
      const progress = msgs.find((m, i) => i > 0 && String(m.content).startsWith("⏳"));
      expect(progress).toBeDefined();

      testBackend.enqueueEvent({ type: "text_delta", text: "second" });
      testBackend.enqueueEvent({ type: "result", text: "done", isError: false });
      testBackend.endStream();
      await vi.advanceTimersByTimeAsync(10);
      await done;

      expect(progress!.delete).toHaveBeenCalled();
      // Old text untouched; new text lands in a message created after the progress one.
      expect(msgs[0].content).toBe("first");
      const secondIdx = msgs.findIndex((m) => m.content === "second");
      expect(secondIdx).toBeGreaterThan(msgs.indexOf(progress!));
    } finally {
      vi.useRealTimers();
    }
  });

  it("posts a task board as soon as a background task starts, and finalizes it", async () => {
    const { sessionManager } = await import("./session-manager.js");
    const channel = makeMockChannel();
    setTimeout(() => {
      testBackend.enqueueEvent({ type: "session_init", sessionId: "sess-1" });
      testBackend.enqueueEvent({ type: "text_delta", text: "Tests started." });
      testBackend.enqueueEvent({ type: "background_tasks", tasks: [{ id: "b1", description: "Run full test suite", taskType: "local_bash" }] });
      testBackend.enqueueEvent({ type: "task_done", id: "b1", status: "completed", summary: "1380 passed", durationMs: 250_000 });
      testBackend.enqueueEvent({ type: "background_tasks", tasks: [] });
      testBackend.enqueueEvent({ type: "result", text: "done", isError: false });
      testBackend.endStream();
    }, 10);
    await sessionManager.sendMessage(channel, "test prompt");
    const msgs = (channel as unknown as { messages: Array<{ components?: unknown[]; flags?: number }> }).messages;
    const boards = msgs.filter((m) => typeof m.flags === "number" && (m.flags & 32768) !== 0);
    expect(boards).toHaveLength(1); // one board message, edited in place
    const json = JSON.stringify((boards[0].components ?? []).map((c) => (c as { toJSON(): unknown }).toJSON()));
    expect(json).toContain("Run full test suite");
    expect(json).toContain("1380 passed");
    expect(json).toContain("Done");
    expect(json).not.toContain("stop:"); // Stop removed once the session is over
    expect(sessionManager.getBoardTask("ch1", "b1")).toMatchObject({ status: "completed", summary: "1380 passed" });
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
    setTimeout(async () => {
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
