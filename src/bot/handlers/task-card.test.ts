import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../claude/session-manager.js", () => ({ sessionManager: { getTaskCard: vi.fn(), stopTask: vi.fn(), recoverTask: vi.fn() } }));
vi.mock("../../db/database.js", () => ({ getProject: vi.fn(), setChannelOverride: vi.fn() }));
vi.mock("../../security/guard.js", () => ({ isAllowedUser: vi.fn(() => true) }));
import { sessionManager } from "../../claude/session-manager.js";
import { getProject, setChannelOverride } from "../../db/database.js";
import { isAllowedUser } from "../../security/guard.js";
import { handleTaskCardInteraction } from "./task-card.js";

const interaction = (action: string) => ({
  customId: `card-${action}:run`, channelId: "ch", user: { id: "user" }, channel: { id: "ch" },
  reply: vi.fn(), update: vi.fn(), deferUpdate: vi.fn(), deferReply: vi.fn(), editReply: vi.fn(),
  isStringSelectMenu: () => false,
  isButton: () => true,
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isAllowedUser).mockReturnValue(true);
  vi.mocked(getProject).mockReturnValue({ backend: "codex", codex_model: "gpt-6.1-sol" } as never);
  vi.mocked(sessionManager.getTaskCard).mockReturnValue({ runId: "run", model: "gpt-6-astra", phase: "running", details: () => "Latest tool: npm test" } as never);
});

describe("task card controls", () => {
  it("requires confirmation before stopping and acknowledges the confirmed request", async () => {
    const first = interaction("stop");
    await handleTaskCardInteraction(first as never);
    expect(sessionManager.stopTask).not.toHaveBeenCalled();
    expect(JSON.stringify(first.reply.mock.calls)).toContain("card-stop-confirm:run");
    vi.mocked(sessionManager.stopTask).mockResolvedValue(true);
    const confirm = interaction("stop-confirm");
    await handleTaskCardInteraction(confirm as never);
    expect(confirm.deferUpdate).toHaveBeenCalled();
    expect(sessionManager.stopTask).toHaveBeenCalledWith("ch", "run");
  });
  it("rejects expired and unauthorized controls without mutations", async () => {
    vi.mocked(sessionManager.getTaskCard).mockReturnValue(undefined);
    const stale = interaction("stop-confirm");
    await handleTaskCardInteraction(stale as never);
    expect(stale.reply).toHaveBeenCalled();
    expect(sessionManager.stopTask).not.toHaveBeenCalled();
    vi.mocked(isAllowedUser).mockReturnValue(false);
    await handleTaskCardInteraction(interaction("model") as never);
    expect(setChannelOverride).not.toHaveBeenCalled();
  });
  it("separates the current actual model from next-turn settings", async () => {
    const model = interaction("model");
    await handleTaskCardInteraction(model as never);
    const reply = JSON.stringify(model.reply.mock.calls);
    expect(reply).toContain("gpt-6-astra");
    expect(reply).toContain("gpt-6.1-sol");
    expect(reply).toContain("next message");
    const select = { ...interaction("model-select"), isStringSelectMenu: () => true, values: ["gpt-6.1-sol"] };
    await handleTaskCardInteraction(select as never);
    expect(setChannelOverride).toHaveBeenCalledWith("ch", "codex_model", "gpt-6.1-sol");
    expect(sessionManager.stopTask).not.toHaveBeenCalled();
  });
  it("does not apply a model after a backend switch or accept forged values", async () => {
    const select = { ...interaction("model-select"), isStringSelectMenu: () => true, values: ["forged"] };
    await handleTaskCardInteraction(select as never);
    vi.mocked(getProject).mockReturnValue({ backend: "claude" } as never);
    select.values = ["gpt-6.1-sol"];
    await handleTaskCardInteraction(select as never);
    expect(setChannelOverride).not.toHaveBeenCalled();
  });
});
