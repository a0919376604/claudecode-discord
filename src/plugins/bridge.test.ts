import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the database and session-manager modules BEFORE importing bridge.
const mockGetProject = vi.fn();
const mockIsActive = vi.fn();
const mockSendMessage = vi.fn();

vi.mock("../db/database.js", () => ({
  getProject: (channelId: string) => mockGetProject(channelId),
}));

vi.mock("../claude/session-manager.js", () => ({
  sessionManager: {
    isActive: (channelId: string) => mockIsActive(channelId),
    sendMessage: (channel: any, prompt: string) =>
      mockSendMessage(channel, prompt),
  },
}));

import { handlePluginCommand } from "./bridge.js";
import type { RegisteredPluginCommand } from "./types.js";

function makeInteraction(opts: {
  channelId?: string;
  options?: Record<string, string>;
  channel?: any;
}) {
  const optsMap = opts.options ?? {};
  return {
    channelId: opts.channelId ?? "chan-1",
    channel: opts.channel ?? { id: opts.channelId ?? "chan-1", send: vi.fn() },
    commandName: "autoresearch",
    options: {
      getString: (name: string) => optsMap[name] ?? null,
    },
    editReply: vi.fn().mockResolvedValue(undefined),
    deferred: true,
    replied: false,
  };
}

function reg(
  commandName: string,
  parsedParams: RegisteredPluginCommand["parsedParams"] = [],
  pluginShortName = "claude-obsidian",
): RegisteredPluginCommand {
  return {
    pluginName: `${pluginShortName}@test-marketplace`,
    pluginShortName,
    pluginInstallPath: `/fake/${pluginShortName}`,
    commandName,
    description: "x",
    parsedParams,
    sourcePath: "/fake",
    registeredAt: Date.now(),
  };
}

describe("handlePluginCommand", () => {
  beforeEach(() => {
    mockGetProject.mockReset();
    mockIsActive.mockReset();
    mockSendMessage.mockReset();
  });

  it("rejects with editReply when channel is not registered", async () => {
    mockGetProject.mockReturnValue(undefined);
    const interaction = makeInteraction({});

    await handlePluginCommand(interaction as any, reg("autoresearch"));

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringMatching(/not registered/i),
      }),
    );
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("rejects with editReply when a session is already active", async () => {
    mockGetProject.mockReturnValue({ project_path: "/p" });
    mockIsActive.mockReturnValue(true);
    const interaction = makeInteraction({});

    await handlePluginCommand(interaction as any, reg("autoresearch"));

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringMatching(/in progress|busy|active/i),
      }),
    );
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("builds '/<plugin>:<cmd>' prompt when no args and dispatches to sessionManager", async () => {
    mockGetProject.mockReturnValue({ project_path: "/p" });
    mockIsActive.mockReturnValue(false);
    const channel = { id: "chan-1", send: vi.fn() };
    const interaction = makeInteraction({ channel });

    await handlePluginCommand(interaction as any, reg("autoresearch"));

    expect(mockSendMessage).toHaveBeenCalledWith(
      channel,
      "/claude-obsidian:autoresearch",
    );
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("/claude-obsidian:autoresearch"),
      }),
    );
  });

  it("includes single `args` value in the prompt for paramless commands", async () => {
    mockGetProject.mockReturnValue({ project_path: "/p" });
    mockIsActive.mockReturnValue(false);
    const interaction = makeInteraction({
      options: { args: "AI agents in 2026" },
    });

    await handlePluginCommand(interaction as any, reg("autoresearch"));

    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.anything(),
      "/claude-obsidian:autoresearch AI agents in 2026",
    );
  });

  it("reconstructs prompt in originalIndex order, not Discord's required-first order", async () => {
    mockGetProject.mockReturnValue({ project_path: "/p" });
    mockIsActive.mockReturnValue(false);
    const interaction = makeInteraction({
      options: { range: "10-20", file: "foo.md" },
    });

    const command = reg("excerpt", [
      { name: "file", description: "file", required: true, originalIndex: 0 },
      { name: "range", description: "range", required: false, originalIndex: 1 },
    ]);

    await handlePluginCommand(interaction as any, command);

    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.anything(),
      "/claude-obsidian:excerpt foo.md 10-20",
    );
  });

  it("drops empty trailing param values from the prompt", async () => {
    mockGetProject.mockReturnValue({ project_path: "/p" });
    mockIsActive.mockReturnValue(false);
    const interaction = makeInteraction({
      options: { file: "foo.md" },
    });

    const command = reg("excerpt", [
      { name: "file", description: "file", required: true, originalIndex: 0 },
      { name: "range", description: "range", required: false, originalIndex: 1 },
    ]);

    await handlePluginCommand(interaction as any, command);

    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.anything(),
      "/claude-obsidian:excerpt foo.md",
    );
  });
});
