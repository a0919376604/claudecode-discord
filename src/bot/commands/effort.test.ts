import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("../../db/database.js", () => ({ getProject: vi.fn(), setChannelOverride: vi.fn() }));
import { getProject, setChannelOverride } from "../../db/database.js";
import { execute } from "./effort.js";

beforeEach(() => vi.clearAllMocks());
describe("/effort", () => {
  it("applies on DeepTutor channels without the Codex 'ignored' warning", async () => {
    vi.mocked(getProject).mockReturnValue({ backend: "deeptutor", effort: null } as never);
    const editReply = vi.fn();
    await execute({ channelId: "ch", options: { getString: () => "high" }, editReply } as never);
    expect(setChannelOverride).toHaveBeenCalledWith("ch", "effort", "high");
    expect(JSON.stringify(editReply.mock.calls)).not.toContain("ignored");
  });
  it("still warns that Codex channels ignore effort", async () => {
    vi.mocked(getProject).mockReturnValue({ backend: "codex", effort: null } as never);
    const editReply = vi.fn();
    await execute({ channelId: "ch", options: { getString: () => "high" }, editReply } as never);
    expect(JSON.stringify(editReply.mock.calls)).toContain("ignored");
  });
});
