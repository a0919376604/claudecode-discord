import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock all external dependencies before importing session-manager
vi.mock("../utils/i18n.js", () => ({
  L: (en: string, _kr: string) => en,
}));

vi.mock("../db/database.js", () => ({
  upsertSession: vi.fn(),
  updateSessionStatus: vi.fn(),
  getProject: vi.fn(),
  getSession: vi.fn(),
  setAutoApprove: vi.fn(),
}));

vi.mock("../utils/config.js", () => ({
  getConfig: vi.fn(() => ({ SHOW_COST: true })),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

import { sessionManager, flushStreamBuffer } from "./session-manager.js";

// Helper to create a mock TextChannel
function mockChannel(id: string) {
  return { id, send: vi.fn().mockResolvedValue({ edit: vi.fn() }) } as any;
}

describe("SessionManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── isActive ───

  describe("isActive", () => {
    it("returns false for unknown channel", () => {
      expect(sessionManager.isActive("unknown-channel")).toBe(false);
    });
  });

  // ─── resolveApproval ───

  describe("resolveApproval", () => {
    it("returns false for unknown requestId", () => {
      expect(sessionManager.resolveApproval("nonexistent", "approve")).toBe(false);
    });
  });

  // ─── resolveQuestion ───

  describe("resolveQuestion", () => {
    it("returns false for unknown requestId", () => {
      expect(sessionManager.resolveQuestion("nonexistent", "answer")).toBe(false);
    });
  });

  // ─── Custom input ───

  describe("custom input", () => {
    it("hasPendingCustomInput returns false initially", () => {
      expect(sessionManager.hasPendingCustomInput("ch-1")).toBe(false);
    });

    it("enableCustomInput sets pending state", () => {
      sessionManager.enableCustomInput("req-1", "ch-1");
      expect(sessionManager.hasPendingCustomInput("ch-1")).toBe(true);
    });

    it("resolveCustomInput returns false when no pending question", () => {
      sessionManager.enableCustomInput("req-no-question", "ch-2");
      // There's a custom input pending but no matching question in pendingQuestions
      expect(sessionManager.resolveCustomInput("ch-2", "hello")).toBe(false);
    });

    it("resolveCustomInput returns false for channel without pending input", () => {
      expect(sessionManager.resolveCustomInput("ch-no-input", "hello")).toBe(false);
    });
  });

  // ─── Message queue ───

  describe("message queue", () => {
    const channelId = "queue-ch";

    it("hasQueue returns false initially", () => {
      expect(sessionManager.hasQueue(channelId)).toBe(false);
    });

    it("getQueueSize returns 0 initially", () => {
      expect(sessionManager.getQueueSize(channelId)).toBe(0);
    });

    it("isQueueFull returns false when empty", () => {
      expect(sessionManager.isQueueFull(channelId)).toBe(false);
    });

    it("setPendingQueue + hasQueue works", () => {
      const channel = mockChannel(channelId);
      sessionManager.setPendingQueue(channelId, channel, "test prompt");
      expect(sessionManager.hasQueue(channelId)).toBe(true);
    });

    it("confirmQueue moves pending to queue", () => {
      const channel = mockChannel(channelId);
      sessionManager.setPendingQueue(channelId, channel, "prompt 1");
      const result = sessionManager.confirmQueue(channelId);
      expect(result).toBe(true);
      expect(sessionManager.getQueueSize(channelId)).toBe(1);
      expect(sessionManager.hasQueue(channelId)).toBe(false);
    });

    it("confirmQueue returns false when nothing pending", () => {
      expect(sessionManager.confirmQueue("no-pending")).toBe(false);
    });

    it("cancelQueue clears pending", () => {
      const channel = mockChannel(channelId);
      sessionManager.setPendingQueue(channelId, channel, "to cancel");
      sessionManager.cancelQueue(channelId);
      expect(sessionManager.hasQueue(channelId)).toBe(false);
    });

    it("isQueueFull returns true after 5 items", () => {
      const ch = "full-queue-ch";
      const channel = mockChannel(ch);
      for (let i = 0; i < 5; i++) {
        sessionManager.setPendingQueue(ch, channel, `msg ${i}`);
        sessionManager.confirmQueue(ch);
      }
      expect(sessionManager.isQueueFull(ch)).toBe(true);
      expect(sessionManager.getQueueSize(ch)).toBe(5);
    });
  });

  // ─── stopSession ───

  describe("stopSession", () => {
    it("returns false for inactive session", async () => {
      expect(await sessionManager.stopSession("no-session")).toBe(false);
    });
  });
});

// ─── flushStreamBuffer ───

describe("flushStreamBuffer", () => {
  // Build a minimal Message-like mock. The helper only touches .edit.
  function mockMessage() {
    return {
      edit: vi.fn().mockResolvedValue(undefined),
    } as any;
  }

  // Build a minimal TextChannel-like mock. The helper only touches .send.
  // Each .send returns a fresh mock Message so the helper can chain.
  function mockChannel() {
    const sent: any[] = [];
    const send = vi.fn().mockImplementation((_content: any) => {
      const msg = { edit: vi.fn().mockResolvedValue(undefined) };
      sent.push(msg);
      return Promise.resolve(msg);
    });
    return { channel: { send } as any, sent, send };
  }

  it("is a no-op for empty buffer", async () => {
    const { channel, send } = mockChannel();
    const current = mockMessage();
    const result = await flushStreamBuffer(channel, current, "");
    expect(current.edit).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(result.tail).toBe(current);
    expect(result.remainingBuffer).toBe("");
  });

  it("edits currentMessage when buffer fits in one chunk", async () => {
    const { channel, send } = mockChannel();
    const current = mockMessage();
    const result = await flushStreamBuffer(channel, current, "hello world");
    expect(current.edit).toHaveBeenCalledWith({
      content: "hello world",
      components: [],
    });
    expect(send).not.toHaveBeenCalled();
    expect(result.tail).toBe(current);
    // Single-chunk: buffer is preserved (existing streaming pattern —
    // the cumulative buffer keeps growing until an overflow drains it).
    expect(result.remainingBuffer).toBe("hello world");
  });

  it("edits + sends additional messages when buffer overflows", async () => {
    const { channel, send, sent } = mockChannel();
    const current = mockMessage();
    // 5000 chars forces splitMessage to produce multiple chunks
    // (MAX_DISCORD_LENGTH in output-formatter is 1900).
    const longBuffer = "a".repeat(5000);
    const result = await flushStreamBuffer(channel, current, longBuffer);
    expect(current.edit).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalled();
    // tail is the LAST sent message, not the original currentMessage.
    expect(result.tail).toBe(sent[sent.length - 1]);
    // Multi-chunk overflow: buffer drains (preserves existing pattern).
    expect(result.remainingBuffer).toBe("");
  });

  it("falls back to channel.send when edit throws", async () => {
    const { channel, send, sent } = mockChannel();
    const current = mockMessage();
    current.edit = vi
      .fn()
      .mockRejectedValue(new Error("Unknown Message"));
    const result = await flushStreamBuffer(channel, current, "hello");
    expect(send).toHaveBeenCalled();
    // After fallback, tail points to the newly-sent message.
    expect(result.tail).toBe(sent[sent.length - 1]);
  });
});
