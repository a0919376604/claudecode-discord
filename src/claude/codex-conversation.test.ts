import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message, TextChannel } from "discord.js";
vi.mock("../utils/i18n.js", () => ({ L: (en: string) => en }));
import { CodexConversation } from "./codex-conversation.js";

function fixture() {
  const messages: Array<Record<string, any>> = [];
  let active = 0, peak = 0;
  const send = vi.fn(async (payload: any) => {
    const msg: Record<string, any> = { id: String(messages.length), url: `https://discord.com/m/${messages.length}`, ...payload };
    msg.edit = vi.fn(async (patch: any) => {
      peak = Math.max(peak, ++active);
      await Promise.resolve(); Object.assign(msg, patch); --active; return msg;
    });
    msg.delete = vi.fn(async () => { msg.deleted = true; });
    messages.push(msg); return msg;
  });
  const channel = { send } as unknown as TextChannel;
  const flow = new CodexConversation("run-1", "Fix tools", channel);
  return { flow, messages, send, peak: () => peak,
    attach: async () => flow.attach(await send(flow.render()) as unknown as Message) };
}
afterEach(() => vi.useRealTimers());

describe("Codex conversation rendering", () => {
  it("finishes and retires controls after a transient final edit or send failure", async () => {
    const f=fixture();await f.attach();
    await f.flow.observe({type:"tool_start",toolName:"Bash",input:{id:"a",command:"npm test"}});
    f.messages[0].edit.mockRejectedValueOnce(new Error("temporary edit failure"));
    f.send.mockRejectedValueOnce(new Error("temporary send failure"));
    await f.flow.finish("failed","The command failed");
    expect(f.messages.at(-1)?.embeds?.[0].toJSON().description).toContain("The command failed");
    expect(JSON.stringify(f.messages.map(m=>m.components))).not.toContain("card-stop:");
  });
  it("can retry incomplete terminal delivery without changing the authoritative task outcome", async () => {
    const f=fixture();await f.attach();
    await f.flow.observe({type:"tool_start",toolName:"Bash",input:{id:"a",command:"npm test"}});
    f.messages[0].edit.mockRejectedValueOnce(new Error("edit down")).mockRejectedValueOnce(new Error("edit still down"));
    f.send.mockRejectedValueOnce(new Error("send down")).mockRejectedValueOnce(new Error("send still down"));
    await expect(f.flow.finish("failed","Backend failure")).rejects.toThrow();
    await f.flow.finish("done","Wrong replacement outcome");
    expect(f.flow.phase).toBe("failed");
    expect(JSON.stringify(f.messages.at(-1)?.embeds)).toContain("Backend failure");
  });
  it("preserves stopping across asynchronous fallback rendering", async () => {
    const f=fixture();await f.attach();
    const original=f.messages[0].edit.getMockImplementation()!;
    let release!:()=>void;
    f.messages[0].edit.mockImplementationOnce(async(patch: unknown)=>{await new Promise<void>(resolve=>{release=resolve;});return original(patch);});
    const finishing=f.flow.finish("done","Final fallback answer");
    for(let i=0;i<10&&!release;i++)await Promise.resolve();
    expect(release).toBeDefined();f.flow.requestStop();release();await finishing;
    expect(f.flow.phase).toBe("stopped");
  });
  it("does not lose a token arriving during a slow Discord edit", async () => {
    vi.useFakeTimers();
    const f = fixture(); await f.attach();
    await f.flow.observe({ type: "text_delta", itemId: "a", text: "First" });await f.flow.flush();
    const original = f.messages[0].edit.getMockImplementation()!;
    let release!: () => void;
    f.messages[0].edit.mockImplementationOnce(async(patch: unknown)=>{ await new Promise<void>(resolve=>{release=resolve;});return original(patch); });
    await f.flow.observe({ type: "text_delta", itemId: "a", text: " second" });
    const pending = f.flow.flush();await Promise.resolve();
    await f.flow.observe({ type: "text_delta", itemId: "a", text: " TRAILING" });
    release();await pending;await vi.advanceTimersByTimeAsync(1500);
    expect(f.messages[0].content).toBe("First second TRAILING");
    await f.flow.finish("done");
  });
  it("finalizes a long conversation without rewriting or erasing historical tool batches", async () => {
    const f = fixture();await f.attach();
    for(let i=0;i<257;i++) {
      await f.flow.observe({type:"tool_start",toolName:"Bash",input:{id:`tool-${i}`,command:`command-${i}`}});
      await f.flow.observe({type:"tool_end",toolName:"Bash",input:{id:`tool-${i}`},ok:true});
      await f.flow.observe({type:"text_complete",itemId:`text-${i}`,text:`Result ${i}`});
    }
    const edits = f.messages.reduce((n,m)=>n+m.edit.mock.calls.length,0);
    await f.flow.finish("done");
    expect(f.messages.reduce((n,m)=>n+m.edit.mock.calls.length,0)-edits).toBeLessThanOrEqual(2);
    expect(JSON.stringify(f.messages[0].embeds)).toContain("command-0");
  });
  it("moves Stop to the latest segment even when preceding text was already flushed", async () => {
    const f = fixture(); await f.attach();
    await f.flow.observe({ type: "text_delta", text: "Already visible" }); await f.flow.flush();
    await f.flow.observe({ type: "tool_start", toolName: "Bash", input: { id: "a", command: "npm test" } });
    expect(JSON.stringify(f.messages[0].components)).not.toContain("card-stop:");
    expect(JSON.stringify(f.messages[1].components)).toContain("card-stop:");
    await f.flow.finish("done");
  });
  it("flushes trailing text before tools and writes the next answer below the tool batch", async () => {
    const f = fixture(); await f.attach();
    await f.flow.observe({ type: "text_delta", text: "I will ", itemId: "intro" });
    await f.flow.observe({ type: "text_delta", text: "test.", itemId: "intro" });
    await f.flow.observe({ type: "tool_start", toolName: "Bash", input: { id: "cmd", command: "npm test" } });
    expect(JSON.stringify(f.messages[0].components)).not.toContain("card-stop:");
    await f.flow.observe({ type: "tool_end", toolName: "Bash", input: { id: "cmd", exitCode: 0 }, ok: true });
    await f.flow.observe({ type: "text_delta", text: "Done.", itemId: "answer" });
    await f.flow.finish("done", "I will test.Done.");
    expect(f.messages[0].content).toBe("I will test.");
    expect(JSON.stringify(f.messages[1].embeds)).toContain("npm test");
    expect(JSON.stringify(f.messages[1].embeds)).toContain("Completed");
    expect(f.messages[2].content).toBe("Done.");
    expect(f.messages.filter(m => m.content === "Done.")).toHaveLength(1);
    expect(f.peak()).toBe(1);
  });
  it("flushes the last token on a timer and accepts authoritative text without duplication", async () => {
    vi.useFakeTimers();
    const f = fixture(); await f.attach();
    await f.flow.observe({ type: "text_delta", itemId: "a", text: "Hello" });
    await f.flow.flush();
    await f.flow.observe({ type: "text_delta", itemId: "a", text: " world" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(f.messages[0].content).toBe("Hello world");
    await f.flow.observe({ type: "text_complete", itemId: "a", text: "Hello world!", phase: "final_answer" });
    expect(f.messages[0].content).toBe("Hello world!");
    await f.flow.observe({ type: "text_complete", itemId: "b", text: "Second message" });
    await f.flow.finish("done");
    expect(f.messages[1].content).toBe("Second message");
  });
  it("keeps quick tools, bounds the visible list, and updates the correct earlier batch", async () => {
    const f = fixture(); await f.attach();
    for (let i = 0; i < 6; i++) {
      await f.flow.observe({ type: "tool_start", toolName: "Bash", input: { id: `c${i}`, command: `command-${i}` } });
      if(i>0) await f.flow.observe({ type: "tool_end", toolName: "Bash", input: { id: `c${i}` }, ok: true });
    }
    await f.flow.observe({ type: "text_delta", text: "While c0 runs", itemId: "a" });
    await f.flow.observe({ type: "tool_output_delta", itemId: "c0", text: "secret=abc\noutput arrived" });
    await f.flow.observe({ type: "tool_end", toolName: "Bash", input: { id: "c0" }, ok: false });
    await f.flow.finish("failed", "Command failed");
    expect(f.flow.details()).toContain("output arrived");
    expect(f.flow.details()).not.toContain("secret=abc");
    const payload = JSON.stringify(f.messages[0].embeds);
    expect(payload).toContain("6 tool");
    expect(payload).not.toContain("command-1");
    expect(f.messages[1].content).toBe("While c0 runs");
  });
  it("keeps completed items after stopping, removes Stop everywhere, and ignores late events", async () => {
    const f = fixture(); await f.attach();
    await f.flow.observe({ type: "tool_start", toolName: "Read", input: { id: "a", file_path: "a.ts" } });
    await f.flow.observe({ type: "tool_end", toolName: "Read", input: { id: "a" }, ok: true });
    await f.flow.observe({ type: "tool_start", toolName: "Bash", input: { id: "b", command: "npm test" } });
    f.flow.requestStop(); await f.flow.finish("stopped", "Stopped safely");
    await f.flow.observe({ type: "text_delta", text: "late text" });
    await f.flow.finish("done", "late success");
    expect(f.flow.phase).toBe("stopped");
    expect(f.flow.details()).toContain("Completed");
    expect(f.flow.details()).toContain("Stopped");
    expect(JSON.stringify(f.messages)).not.toContain("late text");
    expect(JSON.stringify(f.messages.map(m => m.components))).not.toContain("card-stop:");
    expect(JSON.stringify(f.messages.at(-1)?.components)).toContain("card-recover:run-1");
  });
  it("recreates a deleted tool message and retries a surfaced rate limit without concurrent edits", async () => {
    vi.useFakeTimers();
    const f = fixture(); await f.attach();
    await f.flow.observe({ type: "tool_start", toolName: "Bash", input: { id: "a", command: "npm test" } });
    f.messages[0].edit.mockRejectedValueOnce({ code: 10008 });
    await f.flow.flush(true);
    expect(f.messages.length).toBe(2);
    f.messages[1].edit.mockRejectedValueOnce({ status: 429, retry_after: 0.01 });
    const flushed = f.flow.flush(true);
    await vi.advanceTimersByTimeAsync(20); await flushed;
    await f.flow.finish("done");
    expect(f.peak()).toBe(1);
  });
  it("splits copyable text within Discord limits and does not leak reasoning", async () => {
    const f = fixture(); await f.attach();
    await f.flow.observe({ type: "text_delta", text: "private reasoning", isReasoning: true });
    await f.flow.observe({ type: "text_complete", itemId: "large", text: "text ".repeat(1000) });
    await f.flow.finish("done");
    expect(f.messages.filter(m=>m.content).every(m=>m.content.length<=2000)).toBe(true);
    expect(f.messages.filter(m=>m.content).map(m=>m.content).join("")).toBe("text ".repeat(1000));
    expect(JSON.stringify(f.messages)).not.toContain("private reasoning");
  });
  it("keeps separate approvals and seals text before an external request", async () => {
    const f = fixture(); await f.attach();
    await f.flow.observe({ type: "text_delta", text: "Explanation" });
    await f.flow.observe({ type: "tool_approval_request", requestId: "a", toolName: "Bash", input: {} });
    expect(f.messages[0].content).toBe("Explanation");
    f.flow.need("a", "Approve A", "https://discord.com/a");
    f.flow.need("b", "Approve B", "https://discord.com/b");f.flow.clearNeed("a");
    expect(f.flow.phase).toBe("waiting");
    await f.flow.observe({ type: "text_delta", text: "After approval" });
    await f.flow.finish("failed", "Disconnected");
    expect(f.messages[1].content).toBe("After approval");
  });
});
