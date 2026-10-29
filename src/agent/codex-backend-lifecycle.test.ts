import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { BackendStartOptions, NormalizedEvent } from "./backend.js";
import { encodeFrame, FrameDecoder } from "./codex-rpc.js";

const { spawn, detect } = vi.hoisted(() => ({ spawn: vi.fn(), detect: vi.fn(async () => ({ ok: true })) }));
vi.mock("node:child_process", () => ({ spawn }));
vi.mock("./codex-detect.js", () => ({ detectCodex: detect }));
vi.mock("../wakeup/paths.js", () => ({ resolveWakeupDir: () => "/tmp" }));
import { CodexBackend } from "./codex-backend.js";

const opts: BackendStartOptions = {
  prompt: "hello", cwd: process.cwd(), channelId: "test", skipPermissions: false,
  channel: null as unknown as BackendStartOptions["channel"],
};

function server(onTurn: (stdout: PassThrough) => void, failStart = false) {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const proc = Object.assign(new EventEmitter(), {
    stdout, stdin,
    kill: vi.fn(() => { stdout.end(); proc.emit("exit", 0, null); return true; }),
  });
  const responses: Array<{ id: number | string; result: unknown }> = [];
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const decoder = new FrameDecoder();
  stdin.on("data", (chunk: Buffer) => {
    for (const message of decoder.push(chunk)) {
      const request = message as { id?: number | string; method?: string; result?: unknown };
      if (!request.method) { responses.push(request as typeof responses[number]); continue; }
      if (request.id === undefined) continue;
      requests.push(message as typeof requests[number]);
      const result = request.method === "thread/start" || request.method === "thread/resume" ? { thread: { id: "thread-1" }, model: "actual-codex-model" }
        : request.method === "turn/start" ? { turn: { id: "turn-1" } } : {};
      stdout.write(encodeFrame(failStart && request.method === "thread/start"
        ? { id: request.id, error: { message: "startup failed" } }
        : { id: request.id, result }));
      if (request.method === "turn/start") setImmediate(() => onTurn(stdout));
    }
  });
  spawn.mockReturnValue(proc);
  return { proc, responses, requests };
}

afterEach(() => vi.clearAllMocks());

describe("CodexBackend lifecycle", () => {
  it("keeps the parent running when a child finishes and excludes child output", async () => {
    const { proc } = server(stdout => {
      const notify = (method: string, params: object) => stdout.write(encodeFrame({ method, params }));
      notify("item/agentMessage/delta", { threadId: "child-thread", turnId: "child-turn", itemId: "c1", delta: "Child report" });
      notify("turn/plan/updated", { threadId: "child-thread", turnId: "child-turn", plan: [{ step: "Child work", status: "completed" }] });
      notify("model/rerouted", { threadId: "child-thread", turnId: "child-turn", toModel: "child-model" });
      notify("turn/completed", { threadId: "child-thread", turn: { id: "child-turn", status: "completed" } });
      notify("item/agentMessage/delta", { threadId: "thread-1", turnId: "turn-1", itemId: "p1", delta: "Parent continues" });
      notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } });
    });
    const events: NormalizedEvent[] = [];
    for await (const event of new CodexBackend().start(opts)) events.push(event);
    expect(events).toEqual([
      { type: "session_init", sessionId: "thread-1", model: "actual-codex-model" },
      { type: "text_delta", text: "Parent continues" },
      { type: "result", text: "Parent continues", isError: false },
    ]);
    expect(proc.kill).toHaveBeenCalledOnce();
  });

  it.each([
    { threadId: "thread-1", turn: { id: "old-turn", status: "failed", error: { message: "Old failure" } } },
    { turn: { id: "turn-1", status: "completed" } },
    { threadId: "thread-1", turn: { status: "completed" } },
  ])("ignores stale or unscoped completion: %j", async completion => {
    server(stdout => {
      stdout.write(encodeFrame({ method: "turn/completed", params: completion }));
      stdout.write(encodeFrame({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "old-turn", delta: "Old text" } }));
      stdout.write(encodeFrame({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", delta: "Current result" } }));
      stdout.write(encodeFrame({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } }));
    });
    const events: NormalizedEvent[] = [];
    for await (const event of new CodexBackend().start(opts)) events.push(event);
    expect(events.filter(e => e.type === "result")).toEqual([{ type: "result", text: "Current result", isError: false }]);
    expect(events.filter(e => e.type === "text_delta")).toEqual([{ type: "text_delta", text: "Current result" }]);
  });
  it("does not launch after a stop during detection", async () => {
    let release!: (value: { ok: boolean }) => void;
    detect.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const { requests } = server(stdout => stdout.write(encodeFrame({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } })));
    const backend = new CodexBackend();
    const events = backend.start(opts);
    const first = events.next();
    await backend.interrupt();
    release({ ok: true });
    await first;
    for await (const _event of events) { /* consume */ }
    expect(spawn).not.toHaveBeenCalled();
    expect(requests.some(r => r.method === "turn/start")).toBe(false);
  });
  it("waits for process exit before confirming a stop", async () => {
    const { proc } = server(() => {});
    proc.kill.mockImplementation(() => true);
    const backend = new CodexBackend();
    const events = backend.start(opts);
    await events.next();
    const next = events.next();
    await new Promise(resolve => setImmediate(resolve));
    let confirmed = false;
    const stopped = backend.interrupt().then(() => { confirmed = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(confirmed).toBe(false);
    proc.emit("exit", 0, null);
    await stopped;
    await next;
    await events.return?.(undefined);
  });
  it.each([undefined, "thread-1"])("applies the selected Codex model to new and resumed turns (%s)", async (resumeSessionId) => {
    const { requests } = server(stdout => stdout.write(encodeFrame({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } })));
    for await (const _event of new CodexBackend().start({ ...opts, model: "gpt-6.1-sol", resumeSessionId })) { /* consume */ }
    expect(requests.find(r => r.method === (resumeSessionId ? "thread/resume" : "thread/start"))?.params.model).toBe("gpt-6.1-sol");
    expect(requests.find(r => r.method === "turn/start")?.params.model).toBe("gpt-6.1-sol");
  });
  it.each([undefined, "thread-1"])("reports the effective model for new and resumed threads (%s)", async (resumeSessionId) => {
    server((stdout) => stdout.write(encodeFrame({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } })));
    const events: NormalizedEvent[] = [];
    for await (const event of new CodexBackend().start({ ...opts, resumeSessionId })) events.push(event);
    expect(events[0]).toEqual({ type: "session_init", sessionId: "thread-1", model: "actual-codex-model" });
  });

  it.each(["item/commandExecution/requestApproval", "item/fileChange/requestApproval"])("routes %s through Discord approvals", async (method) => {
    const { proc, responses } = server((stdout) => {
      stdout.write(encodeFrame({ id: "approval-1", method, params: { command: "ls", itemId: "item-1" } }));
    });
    const backend = new CodexBackend();
    const events = backend.start(opts);
    try {
      expect((await events.next()).value).toMatchObject({ type: "session_init" });
      const approval = (await events.next()).value as Extract<NormalizedEvent, { type: "tool_approval_request" }>;
      expect(approval).toMatchObject({ type: "tool_approval_request", toolName: method.includes("commandExecution") ? "Bash" : "Write" });
      backend.respondToApproval(approval.requestId, "allow");
      await new Promise((resolve) => setImmediate(resolve));
      expect(responses).toContainEqual({ jsonrpc: "2.0", id: "approval-1", result: { decision: "accept" } });
    } finally { await backend.interrupt(); await events.return?.(undefined); }
    expect(proc.kill).toHaveBeenCalled();
  }, 500);

  it("releases the child when a consumer stops at the result event", async () => {
    const { proc } = server((stdout) => stdout.write(encodeFrame({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } })));
    for await (const event of new CodexBackend().start(opts)) {
      if (event.type === "result") break;
    }
    expect(proc.kill).toHaveBeenCalledOnce();
  });

  it("releases the child on a startup RPC failure", async () => {
    const { proc } = server(() => {}, true);
    await expect(new CodexBackend().start(opts).next()).rejects.toThrow("startup failed");
    expect(proc.kill).toHaveBeenCalledOnce();
  });

  it("ends a turn with a visible error when the app-server disconnects", async () => {
    const { proc } = server((stdout) => stdout.end());
    const events: NormalizedEvent[] = [];
    try {
      for await (const event of new CodexBackend().start(opts)) events.push(event);
    } catch (err) { expect(err).toBeInstanceOf(Error); }
    expect(proc.kill).toHaveBeenCalledOnce();
    expect(events.some((event) => event.type === "result" && !event.isError)).toBe(false);
    expect(events).toContainEqual({ type: "result", text: "Codex app-server disconnected", isError: true });
  }, 500);

  it("reports process launch errors without leaving the channel waiting", async () => {
    const { proc } = server(() => {});
    spawn.mockImplementationOnce(() => {
      setImmediate(() => proc.emit("error", new Error("spawn codex ENOENT")));
      return proc;
    });
    try {
      for await (const event of new CodexBackend().start(opts)) {
        if (event.type === "result") expect(event.isError).toBe(true);
      }
    } catch (error) { expect(String(error)).toContain("ENOENT"); }
    expect(proc.kill).toHaveBeenCalledOnce();
  }, 500);

  it("cancels unsupported MCP forms with a visible explanation instead of a protocol error", async () => {
    const { responses } = server((stdout) => stdout.write(encodeFrame({
      id: "form-1", method: "mcpServer/elicitation/request",
      params: { mode: "form", serverName: "example", message: "Enter details", requestedSchema: { type: "object" } },
    })));
    const backend = new CodexBackend();
    const events = backend.start(opts);
    try {
      await events.next();
      expect((await events.next()).value).toMatchObject({ type: "text_delta", text: expect.stringContaining("Enter details") });
      await new Promise((resolve) => setImmediate(resolve));
      expect(responses).toContainEqual({ jsonrpc: "2.0", id: "form-1", result: { action: "cancel", content: null } });
    } finally { await backend.interrupt(); await events.return?.(undefined); }
  }, 500);
});
