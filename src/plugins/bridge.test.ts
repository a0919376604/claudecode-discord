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

const mockListProjectSubdirs = vi.fn();
const mockResolveProjectPath = vi.fn();

vi.mock("../utils/project-dirs.js", () => ({
  listProjectSubdirs: (opts: any) => mockListProjectSubdirs(opts),
  resolveProjectPath: (input: string) => mockResolveProjectPath(input),
  PathValidationError: class PathValidationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "PathValidationError";
    }
  },
}));

vi.mock("../utils/config.js", () => ({
  getConfig: () => ({ BASE_PROJECT_DIR: "/base" }),
}));

import { handlePluginCommand, handlePluginAutocomplete } from "./bridge.js";
import type { RegisteredPluginCommand } from "./types.js";
import { PluginRegistry } from "./registry.js";

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
    scope: "plugin",
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

function userReg(
  commandName: string,
  parsedParams: RegisteredPluginCommand["parsedParams"] = [],
): RegisteredPluginCommand {
  return {
    scope: "user",
    pluginName: "<user>",
    pluginShortName: "",
    pluginInstallPath: "",
    commandName,
    description: "x",
    parsedParams,
    sourcePath: "/fake",
    registeredAt: Date.now(),
  };
}

function projectReg(
  commandName: string,
  parsedParams: RegisteredPluginCommand["parsedParams"] = [],
  projectPath = "/fake/proj",
): RegisteredPluginCommand {
  return {
    scope: "project",
    pluginName: "<project>",
    pluginShortName: "",
    pluginInstallPath: "",
    projectPath,
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
      { name: "file", description: "file", required: true, originalIndex: 0, type: "text" },
      { name: "range", description: "range", required: false, originalIndex: 1, type: "text" },
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
      { name: "file", description: "file", required: true, originalIndex: 0, type: "text" },
      { name: "range", description: "range", required: false, originalIndex: 1, type: "text" },
    ]);

    await handlePluginCommand(interaction as any, command);

    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.anything(),
      "/claude-obsidian:excerpt foo.md",
    );
  });

  // User-scope commands (e.g. obsidian-init dropped at ~/.claude/commands/)
  // are resolved by the Claude CLI under their bare name — no plugin
  // namespace to prepend. The bot used to never see these at all; now it
  // does, and the prompt must NOT include a `<short>:` prefix.
  it("uses bare /<cmd> for user-scope commands (no plugin namespace)", async () => {
    mockGetProject.mockReturnValue({ project_path: "/p" });
    mockIsActive.mockReturnValue(false);
    const interaction = makeInteraction({});

    await handlePluginCommand(interaction as any, userReg("obsidian-init"));

    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.anything(),
      "/obsidian-init",
    );
  });

  it("user-scope command preserves args", async () => {
    mockGetProject.mockReturnValue({ project_path: "/p" });
    mockIsActive.mockReturnValue(false);
    const interaction = makeInteraction({
      options: { args: "scan vault" },
    });

    await handlePluginCommand(interaction as any, userReg("obsidian-init"));

    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.anything(),
      "/obsidian-init scan vault",
    );
  });

  it("project-scope command also dispatches as bare /<cmd>", async () => {
    mockGetProject.mockReturnValue({ project_path: "/p" });
    mockIsActive.mockReturnValue(false);
    const interaction = makeInteraction({});

    await handlePluginCommand(interaction as any, projectReg("my-cmd"));

    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.anything(),
      "/my-cmd",
    );
  });
});

function makeAutocompleteInteraction(opts: {
  channelId?: string;
  commandName: string;
  focusedName: string;
  focusedValue: string;
}) {
  return {
    channelId: opts.channelId ?? "chan-1",
    commandName: opts.commandName,
    options: {
      getFocused: (_returnObj: boolean) => ({
        name: opts.focusedName,
        value: opts.focusedValue,
      }),
    },
    respond: vi.fn().mockResolvedValue(undefined),
  };
}

function makeRegistryWith(reg: RegisteredPluginCommand): PluginRegistry {
  const r = new PluginRegistry(new Set());
  // Use the public `register` with a DiscoveredCommand-shaped input.
  r.register([{
    scope: reg.scope,
    pluginName: reg.pluginName,
    pluginShortName: reg.pluginShortName,
    pluginInstallPath: reg.pluginInstallPath,
    projectPath: reg.projectPath,
    commandName: reg.commandName,
    description: reg.description,
    parsedParams: reg.parsedParams,
    sourcePath: reg.sourcePath,
  }]);
  return r;
}

describe("handlePluginAutocomplete", () => {
  beforeEach(() => {
    mockListProjectSubdirs.mockReset();
    mockGetProject.mockReset();
  });

  it("returns [] for an unknown command name", async () => {
    const registry = makeRegistryWith(reg("known"));
    const interaction = makeAutocompleteInteraction({
      commandName: "unknown",
      focusedName: "x",
      focusedValue: "",
    });
    await handlePluginAutocomplete(interaction as any, registry);
    expect(interaction.respond).toHaveBeenCalledWith([]);
    expect(mockListProjectSubdirs).not.toHaveBeenCalled();
  });

  it("returns [] when focused param is not in parsedParams", async () => {
    const registry = makeRegistryWith(reg("scan", [
      { name: "repo", description: "repo", required: true, originalIndex: 0, type: "path" },
    ]));
    const interaction = makeAutocompleteInteraction({
      commandName: "scan",
      focusedName: "other",
      focusedValue: "",
    });
    await handlePluginAutocomplete(interaction as any, registry);
    expect(interaction.respond).toHaveBeenCalledWith([]);
    expect(mockListProjectSubdirs).not.toHaveBeenCalled();
  });

  it("returns [] when focused param has type !== 'path'", async () => {
    const registry = makeRegistryWith(reg("research", [
      { name: "topic", description: "topic", required: true, originalIndex: 0, type: "text" },
    ]));
    const interaction = makeAutocompleteInteraction({
      commandName: "research",
      focusedName: "topic",
      focusedValue: "",
    });
    await handlePluginAutocomplete(interaction as any, registry);
    expect(interaction.respond).toHaveBeenCalledWith([]);
    expect(mockListProjectSubdirs).not.toHaveBeenCalled();
  });

  it("calls listProjectSubdirs with starredAbsolutePath when channel has a project", async () => {
    mockGetProject.mockReturnValue({ project_path: "/my/proj", channel_id: "chan-1" });
    mockListProjectSubdirs.mockReturnValue([{ name: "x", value: "x" }]);
    const registry = makeRegistryWith(reg("architect", [
      { name: "repo-path", description: "repo-path", required: true, originalIndex: 0, type: "path" },
    ]));
    const interaction = makeAutocompleteInteraction({
      channelId: "chan-1",
      commandName: "architect",
      focusedName: "repo-path",
      focusedValue: "",
    });
    await handlePluginAutocomplete(interaction as any, registry);
    expect(mockListProjectSubdirs).toHaveBeenCalledWith({
      focused: "",
      includeBaseDirSelf: false,
      includeCreateNew: false,
      starredAbsolutePath: "/my/proj",
    });
    expect(interaction.respond).toHaveBeenCalledWith([{ name: "x", value: "x" }]);
  });

  it("omits starredAbsolutePath when channel has no project", async () => {
    mockGetProject.mockReturnValue(undefined);
    mockListProjectSubdirs.mockReturnValue([]);
    const registry = makeRegistryWith(reg("architect", [
      { name: "repo", description: "repo", required: true, originalIndex: 0, type: "path" },
    ]));
    const interaction = makeAutocompleteInteraction({
      channelId: "chan-2",
      commandName: "architect",
      focusedName: "repo",
      focusedValue: "",
    });
    await handlePluginAutocomplete(interaction as any, registry);
    expect(mockListProjectSubdirs).toHaveBeenCalledWith({
      focused: "",
      includeBaseDirSelf: false,
      includeCreateNew: false,
      starredAbsolutePath: undefined,
    });
  });

  it("caps response to first 25 choices", async () => {
    mockGetProject.mockReturnValue(undefined);
    const many = Array.from({ length: 40 }, (_, i) => ({ name: `d${i}`, value: `d${i}` }));
    mockListProjectSubdirs.mockReturnValue(many);
    const registry = makeRegistryWith(reg("architect", [
      { name: "repo", description: "repo", required: true, originalIndex: 0, type: "path" },
    ]));
    const interaction = makeAutocompleteInteraction({
      commandName: "architect",
      focusedName: "repo",
      focusedValue: "",
    });
    await handlePluginAutocomplete(interaction as any, registry);
    const respondArg = interaction.respond.mock.calls[0][0];
    expect(respondArg).toHaveLength(25);
  });
});

describe("buildPrompt — path-typed arg resolution", () => {
  beforeEach(() => {
    mockResolveProjectPath.mockReset();
    mockGetProject.mockReturnValue({ project_path: "/any", channel_id: "chan-1" });
    mockIsActive.mockReturnValue(false);
    mockSendMessage.mockReset();
  });

  it("resolves a relative path-typed value to absolute and dispatches", async () => {
    mockResolveProjectPath.mockImplementation((v: string) =>
      v.startsWith("/") ? v : `/base/${v}`,
    );
    const registry = makeRegistryWith(reg("architect", [
      { name: "repo", description: "repo", required: true, originalIndex: 0, type: "path" },
    ]));
    const interaction = makeInteraction({
      channelId: "chan-1",
      options: { repo: "monorepo/foo" },
    });
    // commandName needs to match the registered command
    interaction.commandName = "architect";
    await handlePluginCommand(interaction as any, registry.lookup("architect")!);
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.anything(),
      "/claude-obsidian:architect /base/monorepo/foo",
    );
  });

  it("passes absolute path-typed values through without joining base", async () => {
    mockResolveProjectPath.mockImplementation((v: string) =>
      v.startsWith("/") ? v : `/base/${v}`,
    );
    const registry = makeRegistryWith(reg("architect", [
      { name: "repo", description: "repo", required: true, originalIndex: 0, type: "path" },
    ]));
    const interaction = makeInteraction({
      channelId: "chan-1",
      options: { repo: "/elsewhere/repo" },
    });
    interaction.commandName = "architect";
    await handlePluginCommand(interaction as any, registry.lookup("architect")!);
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.anything(),
      "/claude-obsidian:architect /elsewhere/repo",
    );
  });

  it("rejects '..' in any path-typed value with ephemeral reply, no dispatch", async () => {
    const registry = makeRegistryWith(reg("architect", [
      { name: "repo", description: "repo", required: true, originalIndex: 0, type: "path" },
    ]));
    const interaction = makeInteraction({
      channelId: "chan-1",
      options: { repo: "../etc" },
    });
    interaction.commandName = "architect";
    await handlePluginCommand(interaction as any, registry.lookup("architect")!);
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Invalid path"),
      }),
    );
  });

  it("does not resolve text-typed values", async () => {
    const registry = makeRegistryWith(reg("research", [
      { name: "topic", description: "topic", required: true, originalIndex: 0, type: "text" },
    ]));
    const interaction = makeInteraction({
      channelId: "chan-1",
      options: { topic: "AI safety" },
    });
    interaction.commandName = "research";
    await handlePluginCommand(interaction as any, registry.lookup("research")!);
    expect(mockResolveProjectPath).not.toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.anything(),
      "/claude-obsidian:research AI safety",
    );
  });
});
