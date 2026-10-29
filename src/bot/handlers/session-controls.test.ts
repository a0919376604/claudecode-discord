import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ButtonInteraction, StringSelectMenuInteraction } from "discord.js";

vi.mock("../../security/guard.js", () => ({ isAllowedUser: () => true }));
vi.mock("../../claude/session-manager.js", () => ({ sessionManager: {} }));
vi.mock("../../db/database.js", () => ({
  getProject: vi.fn(), getSession: vi.fn(), upsertSession: vi.fn(),
  clearSessionId: vi.fn(), setBackend: vi.fn(),
}));
import { getProject, getSession, upsertSession } from "../../db/database.js";
import { handleButtonInteraction, handleSelectMenuInteraction } from "./interaction.js";

function interaction(customId: string, values: string[] = []) {
  return { customId, values, channelId: "ch1", user: { id: "user" },
    deferUpdate: vi.fn(), update: vi.fn(), editReply: vi.fn(), reply: vi.fn() };
}

describe("session controls", () => {
  let home: string;
  let file: string;
  beforeEach(() => {
    vi.clearAllMocks();
    home = fs.mkdtempSync(path.join(os.tmpdir(), "session-controls-"));
    vi.stubEnv("CODEX_HOME", home);
    const dir = path.join(home, "sessions", "2026", "10", "28");
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, "rollout-thread-1.jsonl");
    fs.writeFileSync(file, [
      { type: "session_meta", payload: { id: "thread-1", cwd: "/proj" } },
      { type: "event_msg", payload: { type: "user_message", message: "My task" } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Last Codex answer" }] } },
    ].map(e => JSON.stringify(e)).join("\n"));
    vi.mocked(getProject).mockReturnValue({ channel_id: "ch1", guild_id: "g1", project_path: "/proj", backend: "codex", auto_approve: 0, source_path: null, created_at: "" });
    vi.mocked(getSession).mockReturnValue(undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("previews a Codex rollout and resumes its thread ID", async () => {
    const select = interaction("session-select:codex", ["thread-1"]);
    await handleSelectMenuInteraction(select as unknown as StringSelectMenuInteraction);
    const reply = select.editReply.mock.calls[0][0];
    expect(reply.embeds[0].description).toContain("Last Codex answer");
    const button = reply.components[0].toJSON().components[0].custom_id;
    await handleButtonInteraction(interaction(button) as unknown as ButtonInteraction);
    expect(upsertSession).toHaveBeenCalledWith(expect.any(String), "ch1", "thread-1", "idle");
  });

  it("deletes the Codex rollout and clears the selected active thread", async () => {
    vi.mocked(getSession).mockReturnValue({ session_id: "thread-1" } as ReturnType<typeof getSession>);
    await handleButtonInteraction(interaction("session-delete:codex:thread-1") as unknown as ButtonInteraction);
    expect(fs.existsSync(file)).toBe(false);
    expect(upsertSession).toHaveBeenCalledWith(expect.any(String), "ch1", null, "idle");
  });

  it.each(["session-resume:claude:thread-1", "session-delete:claude:thread-1"])("rejects stale provider button %s", async customId => {
    const button = interaction(customId);
    await handleButtonInteraction(button as unknown as ButtonInteraction);
    expect(button.update.mock.calls[0][0].content).toContain("/sessions");
    expect(fs.existsSync(file)).toBe(true);
    expect(upsertSession).not.toHaveBeenCalled();
  });

  it("rejects the new-session option from a stale Claude menu", async () => {
    const select = interaction("session-select:claude", ["__new_session__"]);
    await handleSelectMenuInteraction(select as unknown as StringSelectMenuInteraction);
    expect(select.update.mock.calls[0][0].content).toContain("/sessions");
    expect(upsertSession).not.toHaveBeenCalled();
  });
});
