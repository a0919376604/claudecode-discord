import { describe, it, expect, vi, beforeEach } from "vitest";
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
    msg.edit = vi.fn(async (patch: unknown) => Object.assign(msg, patch));
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
