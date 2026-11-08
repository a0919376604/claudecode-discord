import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("../../db/database.js", () => ({ getProject: vi.fn(), setChannelOverride: vi.fn() }));
vi.mock("../../utils/config.js", () => ({ getConfig: () => ({ CLAUDE_MODEL: "opus" }) }));
import { getProject, setChannelOverride } from "../../db/database.js";
import { execute, autocomplete } from "./model.js";

beforeEach(() => vi.clearAllMocks());
describe("/model", () => {
  it.each(["claude", "codex"] as const)("writes only the %s preference", async backend => {
    vi.mocked(getProject).mockReturnValue({ backend, model: "opus", codex_model: "gpt-6-astra" } as never);
    const editReply = vi.fn();
    await execute({ channelId: "ch", options: { getString: () => "gpt-6.1-sol" }, editReply } as never);
    expect(setChannelOverride).toHaveBeenCalledWith("ch", backend === "codex" ? "codex_model" : "model", "gpt-6.1-sol");
    expect(JSON.stringify(editReply.mock.calls)).toContain("next message");
    expect(JSON.stringify(editReply.mock.calls)).not.toContain("ignored until");
  });
  it("resets Codex separately and suggests Codex models", async () => {
    vi.mocked(getProject).mockReturnValue({ backend: "codex", model: "opus", last_model: "gpt-6.1-sol" } as never);
    const respond = vi.fn();
    await autocomplete({ channelId: "ch", options: { getFocused: () => "" }, respond } as never);
    expect(JSON.stringify(respond.mock.calls)).toContain("gpt-6.1-sol");
    expect(JSON.stringify(respond.mock.calls)).not.toContain("opus");
    await execute({ channelId: "ch", options: { getString: () => "default" }, editReply: vi.fn() } as never);
    expect(setChannelOverride).toHaveBeenCalledWith("ch", "codex_model", null);
  });
  it("DeepTutor channels store the model, suggest Claude Code aliases and name DeepTutor", async () => {
    vi.mocked(getProject).mockReturnValue({ backend: "deeptutor", model: null } as never);
    const respond = vi.fn();
    await autocomplete({ channelId: "ch", options: { getFocused: () => "" }, respond } as never);
    expect(JSON.stringify(respond.mock.calls)).toContain("haiku");
    const editReply = vi.fn();
    await execute({ channelId: "ch", options: { getString: () => "opus" }, editReply } as never);
    expect(setChannelOverride).toHaveBeenCalledWith("ch", "model", "opus");
    expect(JSON.stringify(editReply.mock.calls)).toContain("DeepTutor");
  });
  it("DeepTutor default falls back to DeepTutor's own setting, not CLAUDE_MODEL", async () => {
    vi.mocked(getProject).mockReturnValue({ backend: "deeptutor", model: null } as never);
    const editReply = vi.fn();
    await execute({ channelId: "ch", options: { getString: () => null }, editReply } as never);
    expect(JSON.stringify(editReply.mock.calls)).toContain("DeepTutor config");
  });
});
