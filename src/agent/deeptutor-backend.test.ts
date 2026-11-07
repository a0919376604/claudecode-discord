import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { BackendStartOptions, NormalizedEvent } from "./backend.js";
import type { Tutor } from "../db/types.js";

const { spawn, getTutor, setTutorSession } = vi.hoisted(() => ({ spawn: vi.fn(), getTutor: vi.fn(), setTutorSession: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
vi.mock("../db/tutors.js", () => ({ getTutor, setTutorSession }));
vi.mock("../utils/config.js", () => ({ getConfig: () => ({ DEEPTUTOR_BIN: "deeptutor" }) }));
import { DeepTutorBackend } from "./deeptutor-backend.js";

const tutor: Tutor = {
  channel_id: "ch", subject: "English", goal: "IELTS 7", level: null, deadline: null,
  daily_minutes: null, menu: null, push_time: "08:00", timezone: "Asia/Taipei", language: "zh",
  deeptutor_session_id: null, created_at: 0,
};
const opts: BackendStartOptions = {
  prompt: "hello", cwd: process.cwd(), channelId: "ch", skipPermissions: false,
  channel: null as unknown as BackendStartOptions["channel"],
};
function child(run: (proc: ReturnType<typeof makeChild>) => void) {
  const proc = makeChild();
  spawn.mockImplementation(() => { setImmediate(() => run(proc)); return proc; });
  return proc;
}
function makeChild() {
  const proc = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(),
    unref: vi.fn(),
    kill: vi.fn((_signal?: string) => { proc.stdout.end(); proc.stderr.end(); proc.emit("exit", 0); return true; }),
  });
  return proc;
}
async function collect(backend = new DeepTutorBackend(), options = opts): Promise<NormalizedEvent[]> {
  const events: NormalizedEvent[] = [];
  for await (const event of backend.start(options)) events.push(event);
  return events;
}
beforeEach(() => { vi.clearAllMocks(); getTutor.mockReturnValue({ ...tutor }); });

describe("DeepTutorBackend", () => {
  it("first run omits --session and stores the new session id", async () => {
    child(p => p.stdout.write([
      { type: "session", metadata: { session_id: "s9" }, session_id: "s9" },
      { type: "content", content: "Hello", session_id: "s9" }, { type: "done", session_id: "s9" },
    ].map(e => JSON.stringify(e)).join("\n") + "\n"));
    expect(await collect()).toEqual([
      { type: "session_init", sessionId: "s9" }, { type: "text_delta", text: "Hello" }, { type: "result", text: "", isError: false },
    ]);
    expect(spawn).toHaveBeenCalledWith("deeptutor", ["run", "mastery_path", "hello", "--format", "json", "-l", "zh"], { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    expect(setTutorSession.mock.calls).toEqual([["ch", "s9"]]);
  });
  it("resumes with stored session id and ignores opts.resumeSessionId", async () => {
    getTutor.mockReturnValue({ ...tutor, deeptutor_session_id: "s1" });
    child(p => p.stdout.write('{"type":"done"}\n'));
    await collect(new DeepTutorBackend(), { ...opts, resumeSessionId: "other" });
    expect(spawn.mock.calls[0][1]).toEqual(["run", "mastery_path", "hello", "--session", "s1", "--format", "json", "-l", "zh"]);
  });
  it("noisy stdout reassembles split lines", async () => {
    child(p => {
      p.stdout.write('log noise\n{"type":"content","con');
      p.stdout.write('tent":"Hello"}\n{"type":"done"}\n');
    });
    expect(await collect()).toContainEqual({ type: "text_delta", text: "Hello" });
  });
  it.each(["stderr", "stdout"] as const)("stale session on %s", async stream => {
    getTutor.mockReturnValue({ ...tutor, deeptutor_session_id: "s1" });
    child(p => { p[stream].write("Conversation not found\n"); p.stdout.end(); p.stderr.end(); p.emit("exit", 1); });
    const backend = new DeepTutorBackend();
    expect(await collect(backend)).toEqual([{ type: "result", text: expect.stringContaining("/tutor reset"), isError: true }]);
    expect(setTutorSession).not.toHaveBeenCalled();
    expect(backend.isResumeStaleError(new Error("Conversation not found"))).toBe(false);
  });
  it("missing binary ends with one install error", async () => {
    child(p => p.emit("error", Object.assign(new Error("spawn deeptutor ENOENT"), { code: "ENOENT" })));
    const backend = new DeepTutorBackend();
    const events = await collect(backend);
    expect(events).toEqual([{ type: "result", text: "DeepTutor CLI not found (DEEPTUTOR_BIN=deeptutor).", isError: true }]);
    const result = events[0] as Extract<NormalizedEvent, { type: "result" }>;
    expect(backend.getAuthErrorHint(new Error(result.text))).toContain("pip install -e .");
  });
  it("no tutor row", async () => {
    getTutor.mockReturnValue(undefined);
    expect(await collect()).toEqual([{ type: "result", text: expect.stringContaining("/tutor setup"), isError: true }]);
    expect(spawn).not.toHaveBeenCalled();
  });
  it("normal finish yields one result on done and never kills the child", async () => {
    const proc = child(p => p.stdout.write('{"type":"content","content":"Hi"}\n{"type":"result","content":""}\n{"type":"done"}\n'));
    expect(await collect()).toEqual([
      { type: "text_delta", text: "Hi" }, { type: "result", text: "", isError: false },
    ]);
    expect(proc.kill).not.toHaveBeenCalled();
  });
  it("exiting after result without done yields an error", async () => {
    child(p => {
      p.stdout.end('{"type":"result","content":""}\n');
      p.stderr.end();
      p.emit("exit", 0);
    });
    expect(await collect()).toEqual([{ type: "result", text: "DeepTutor exited with code 0", isError: true }]);
  });
  it("error event yields one result without killing the child", async () => {
    const proc = child(p => p.stdout.write('{"type":"error","content":"bad"}\n{"type":"done"}\n'));
    expect(await collect()).toEqual([{ type: "result", text: "bad", isError: true }]);
    expect(proc.kill).not.toHaveBeenCalled();
  });
  it("abandoning the iterator terminates the child", async () => {
    const proc = child(p => p.stdout.write('{"type":"content","content":"Working"}\n'));
    const stream = new DeepTutorBackend().start(opts);
    await stream.next();
    await stream.return(undefined);
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  });
  it("duplicate question card text is yielded once", async () => {
    child(p => {
      const metadata = { tool: "mastery_quiz", tool_metadata: { mastery_question: { prompt: "Pick", options: [{ label: "A", body: "large" }] } } };
      p.stdout.write([{ type: "tool_result", metadata }, { type: "content", content: "Try this", metadata }, { type: "done" }].map(e => JSON.stringify(e)).join("\n") + "\n");
    });
    expect((await collect()).filter(e => e.type === "text_delta" && e.text.includes("📝 Pick"))).toHaveLength(1);
  });
  it("captures session id from any event and emits it only once", async () => {
    child(p => p.stdout.write('{"type":"content","content":"Hi","session_id":"s9"}\n{"type":"session","session_id":"s9"}\n{"type":"done"}\n'));
    expect((await collect()).filter(e => e.type === "session_init")).toEqual([{ type: "session_init", sessionId: "s9" }]);
    expect(setTutorSession.mock.calls).toEqual([["ch", "s9"]]);
  });
  it("interrupt terminates the child and ends the stream", async () => {
    const proc = child(p => p.stdout.write('{"type":"content","content":"Working"}\n'));
    const backend = new DeepTutorBackend();
    const stream = backend.start(opts);
    expect((await stream.next()).value).toEqual({ type: "text_delta", text: "Working" });
    await backend.interrupt();
    for await (const _event of stream) { /* drain */ }
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
