import { describe, it, expect } from "vitest";
import { CodexBackend } from "./codex-backend.js";
import type { BackendStartOptions } from "./backend.js";

const gate = process.env.CI_HAS_CODEX ? describe : describe.skip;

gate("CodexBackend end-to-end", () => {
  it("completes a hello-world turn", async () => {
    const backend = new CodexBackend();
    const events: string[] = [];
    let text = "";
    let sessionId: string | null = null;
    let didResult = false;

    const opts: BackendStartOptions = {
      prompt: "Reply with exactly the word: hello",
      cwd: process.cwd(),
      skipPermissions: true,
      channelId: "test-channel",
      // channel is only used by Claude backend for AskUserQuestion UI;
      // CodexBackend never accesses it, so a stub is sufficient.
      channel: null as unknown as BackendStartOptions["channel"],
    };

    for await (const ev of backend.start(opts)) {
      events.push(ev.type);
      if (ev.type === "session_init") sessionId = ev.sessionId;
      if (ev.type === "text_delta") text += ev.text;
      if (ev.type === "result") { didResult = true; break; }
    }

    expect(sessionId).toBeTruthy();
    expect(didResult).toBe(true);
    expect(text.toLowerCase()).toContain("hello");
    expect(events).toContain("session_init");
    expect(events).toContain("result");
  }, 60_000);
});
