import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  execute,
  findSessionFile,
  findSessionDir,
  getLastAssistantMessage,
  getLastAssistantMessageFull,
} from "./sessions.js";

// Mock database imports used by the module
vi.mock("../../db/database.js", () => ({
  getProject: vi.fn(),
  getSession: vi.fn(),
  upsertSession: vi.fn(),
}));

// ─── findSessionDir ───

describe("findSessionDir", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when ~/.claude/projects does not exist", () => {
    vi.spyOn(os, "homedir").mockReturnValue("/fake/home");
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    expect(findSessionDir("/my/project")).toBeNull();
  });

  it("returns encoded path when simple conversion matches", () => {
    vi.spyOn(os, "homedir").mockReturnValue("/fake/home");
    vi.spyOn(fs, "existsSync").mockImplementation((p) => {
      const ps = String(p);
      if (ps === "/fake/home/.claude/projects") return true;
      if (ps === "/fake/home/.claude/projects/-my-project") return true;
      return false;
    });
    expect(findSessionDir("/my/project")).toBe(
      "/fake/home/.claude/projects/-my-project",
    );
  });

  it("returns null when no matching directory found", () => {
    vi.spyOn(os, "homedir").mockReturnValue("/fake/home");
    vi.spyOn(fs, "existsSync").mockImplementation((p) => {
      const ps = String(p);
      return ps === "/fake/home/.claude/projects";
    });
    vi.spyOn(fs, "readdirSync").mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>);
    expect(findSessionDir("/unknown/project")).toBeNull();
  });
});

// ─── getLastAssistantMessage ───

describe("getLastAssistantMessage", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sessions-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeJsonl(filename: string, lines: unknown[]): string {
    const filePath = path.join(tmpDir, filename);
    fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n"));
    return filePath;
  }

  it("returns last assistant text (last line of last message)", async () => {
    const file = writeJsonl("test.jsonl", [
      { type: "assistant", message: { content: [{ type: "text", text: "First" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "Second" }] } },
    ]);
    expect(await getLastAssistantMessage(file)).toBe("Second");
  });

  it("handles string content", async () => {
    const file = writeJsonl("test.jsonl", [
      { type: "assistant", message: { content: "Simple string" } },
    ]);
    expect(await getLastAssistantMessage(file)).toBe("Simple string");
  });

  it("returns last line of multi-line text", async () => {
    const file = writeJsonl("test.jsonl", [
      { type: "assistant", message: { content: [{ type: "text", text: "Line 1\nLine 2\nLine 3" }] } },
    ]);
    expect(await getLastAssistantMessage(file)).toBe("Line 3");
  });

  it("returns '(no message)' when no assistant messages", async () => {
    const file = writeJsonl("test.jsonl", [
      { type: "user", message: { content: "hello" } },
    ]);
    expect(await getLastAssistantMessage(file)).toBe("(no message)");
  });

  it("skips malformed JSON lines", async () => {
    const filePath = path.join(tmpDir, "test.jsonl");
    const lines = [
      "not json",
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Valid" }] } }),
      "{broken",
    ];
    fs.writeFileSync(filePath, lines.join("\n"));
    expect(await getLastAssistantMessage(filePath)).toBe("Valid");
  });

  it("skips assistant messages with empty/whitespace text", async () => {
    const file = writeJsonl("test.jsonl", [
      { type: "assistant", message: { content: [{ type: "text", text: "Good" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "   \n  " }] } },
    ]);
    expect(await getLastAssistantMessage(file)).toBe("Good");
  });

  it("handles multiple text blocks in content array", async () => {
    const file = writeJsonl("test.jsonl", [
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Part A " },
            { type: "text", text: "Part B" },
          ],
        },
      },
    ]);
    expect(await getLastAssistantMessage(file)).toBe("Part A Part B");
  });
});

// ─── getLastAssistantMessageFull ───

describe("getLastAssistantMessageFull", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sessions-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns full text instead of just last line", async () => {
    const filePath = path.join(tmpDir, "test.jsonl");
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Line 1\nLine 2\nLine 3" }] },
    });
    fs.writeFileSync(filePath, line);
    const result = await getLastAssistantMessageFull(filePath);
    expect(result).toContain("Line 1");
    expect(result).toContain("Line 2");
    expect(result).toContain("Line 3");
  });

  it("returns '(no message)' when no assistant messages", async () => {
    const filePath = path.join(tmpDir, "test.jsonl");
    fs.writeFileSync(filePath, JSON.stringify({ type: "user", message: { content: "hi" } }));
    expect(await getLastAssistantMessageFull(filePath)).toBe("(no message)");
  });
});

// Real JSONL fixtures catch provider mixing, wrong project matching, and rollout IDs.
import { getProject, getSession } from "../../db/database.js";
import type { ChatInputCommandInteraction } from "discord.js";

describe("provider-aware sessions", () => {
  let home: string;
  const id = "019abc00-0000-7000-8000-000000000001";

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "provider-sessions-"));
    vi.spyOn(os, "homedir").mockReturnValue(home);
    vi.stubEnv("CODEX_HOME", path.join(home, "custom-codex"));
    vi.mocked(getSession).mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  function codexFile(sessionId: string, cwd = "/my/project") {
    const dir = path.join(process.env.CODEX_HOME!, "sessions", "2026", "10", "28");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rollout-2026-10-28T00-00-00-${sessionId}.jsonl`);
    fs.writeFileSync(file, [
      { type: "session_meta", payload: { id: sessionId, cwd, timestamp: "2026-10-28T00:00:00Z" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>injected context</environment_context>" }] } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the Codex bug" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Codex answer\nAll fixed" }] } },
    ].map(e => JSON.stringify(e)).join("\n"));
    return file;
  }

  function claudeFile() {
    const dir = path.join(home, ".claude", "projects", "-my-project");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "claude-session.jsonl"), JSON.stringify({
      type: "user", message: { content: "Claude task " + "x".repeat(600) },
    }));
  }

  async function run(backend: "claude" | "codex") {
    vi.mocked(getProject).mockReturnValue({
      channel_id: "ch1", project_path: "/my/project", backend,
      guild_id: "g", auto_approve: 0, source_path: null, created_at: "",
    });
    const editReply = vi.fn();
    await execute({ channelId: "ch1", editReply } as unknown as ChatInputCommandInteraction);
    return editReply.mock.calls[0][0];
  }

  it("lists only Codex sessions from this project and marks the active thread", async () => {
    codexFile(id);
    codexFile("other-project", "/other/project");
    claudeFile();
    vi.mocked(getSession).mockReturnValue({ session_id: id } as ReturnType<typeof getSession>);
    const reply = await run("codex");
    expect(reply.embeds[0].title).toContain("Codex");
    const options = reply.components[0].toJSON().components[0].options;
    expect(options.map((o: { value: string }) => o.value)).toEqual(["__new_session__", id]);
    expect(options[1].label).toContain("Fix the Codex bug");
    expect(options[1].default).toBe(true);
  });

  it("keeps Claude sessions separate after switching back", async () => {
    codexFile(id);
    claudeFile();
    const reply = await run("claude");
    const options = reply.components[0].toJSON().components[0].options;
    expect(options.map((o: { value: string }) => o.value)).toEqual(["__new_session__", "claude-session"]);
  });

  it.each(["/my/project", "/other/project"])("uses the rollout's own metadata when inherited metadata has cwd %s", async (inheritedCwd) => {
    const parentId = "019abc00-0000-7000-8000-000000000002";
    codexFile(parentId);
    const file = codexFile(id);
    const lines = fs.readFileSync(file, "utf-8").split("\n");
    lines.splice(1, 0, JSON.stringify({
      type: "session_meta", payload: { id: parentId, cwd: inheritedCwd },
    }));
    fs.writeFileSync(file, lines.join("\n"));
    vi.mocked(getSession).mockReturnValue({ session_id: id } as ReturnType<typeof getSession>);

    const reply = await run("codex");
    const options = reply.components[0].toJSON().components[0].options;
    expect(options.map((o: { value: string }) => o.value).sort()).toEqual([
      id, parentId, "__new_session__",
    ].sort());
    expect(options.find((o: { value: string }) => o.value === id)?.default).toBe(true);
    expect(await findSessionFile("/my/project", id, "codex")).toBe(file);
  });

  it("resolves Codex rollout files by metadata for previews and deletion", async () => {
    const file = codexFile(id);
    expect(await findSessionFile("/my/project", id, "codex")).toBe(file);
    expect(await findSessionFile("/other/project", id, "codex")).toBeNull();
    expect(await getLastAssistantMessage(file)).toBe("All fixed");
  });

  it("shows a fresh Codex session when its storage is absent", async () => {
    claudeFile();
    const reply = await run("codex");
    expect(reply.embeds[0].title).toContain("New Session");
  });
});
