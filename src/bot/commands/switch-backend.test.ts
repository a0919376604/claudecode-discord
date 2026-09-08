import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db/database.js", () => ({
  getProject: vi.fn(),
  clearSessionId: vi.fn(),
  setBackend: vi.fn(),
}));
vi.mock("../../claude/session-manager.js", () => ({
  sessionManager: { isActive: vi.fn(() => false) },
}));
vi.mock("../../agent/codex-detect.js", () => ({
  detectCodex: vi.fn(async () => ({ ok: true, errorMessage: "" })),
}));

import { getProject } from "../../db/database.js";
import { sessionManager } from "../../claude/session-manager.js";
import { createSwitchBackendCommand } from "./switch-backend.js";

const mockGetProject = vi.mocked(getProject);
const mockIsActive = vi.mocked(sessionManager.isActive);

function makeInteraction(channelId = "ch1") {
  return {
    channelId,
    reply: vi.fn(async () => undefined),
  } as unknown as import("discord.js").ChatInputCommandInteraction;
}

describe("createSwitchBackendCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetProject.mockReset();
    mockIsActive.mockReset();
  });

  it("rejects when project is not registered", async () => {
    mockGetProject.mockReturnValue(undefined);
    const cmd = createSwitchBackendCommand("codex", "Codex");
    const inter = makeInteraction();
    await cmd.execute(inter);
    expect(inter.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("/register"), ephemeral: true }),
    );
  });

  it("reports no-op when already on target backend", async () => {
    mockGetProject.mockReturnValue({
      channel_id: "ch1", project_path: "/p", guild_id: "g", auto_approve: 0,
      source_path: null, backend: "codex", created_at: "",
    });
    const cmd = createSwitchBackendCommand("codex", "Codex");
    const inter = makeInteraction();
    await cmd.execute(inter);
    expect(inter.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("Already using") }),
    );
  });

  it("blocks switch when session is active", async () => {
    mockGetProject.mockReturnValue({
      channel_id: "ch1", project_path: "/p", guild_id: "g", auto_approve: 0,
      source_path: null, backend: "claude", created_at: "",
    });
    mockIsActive.mockReturnValue(true);
    const cmd = createSwitchBackendCommand("codex", "Codex");
    const inter = makeInteraction();
    await cmd.execute(inter);
    expect(inter.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("/stop") }),
    );
  });

  it("shows confirm buttons when switch is valid", async () => {
    mockGetProject.mockReturnValue({
      channel_id: "ch1", project_path: "/p", guild_id: "g", auto_approve: 0,
      source_path: null, backend: "claude", created_at: "",
    });
    mockIsActive.mockReturnValue(false);
    const cmd = createSwitchBackendCommand("codex", "Codex");
    const inter = makeInteraction();
    await cmd.execute(inter);
    const call = (inter.reply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.components).toBeDefined();
    expect(call.content).toContain("Continue?");
  });
});
