import { describe, it, expect, beforeEach } from "vitest";
import { PluginRegistry } from "./registry.js";
import type { DiscoveredCommand, ParsedParam } from "./types.js";

function cmd(
  pluginName: string,
  commandName: string,
  description = "desc",
): DiscoveredCommand {
  const pluginShortName = pluginName.includes("@")
    ? pluginName.slice(0, pluginName.indexOf("@"))
    : pluginName;
  return {
    scope: "plugin",
    pluginName,
    pluginShortName,
    pluginInstallPath: `/fake/${pluginShortName}`,
    commandName,
    description,
    parsedParams: [],
    sourcePath: `/fake/${pluginShortName}/${commandName}.md`,
  };
}

describe("PluginRegistry", () => {
  let registry: PluginRegistry;
  const botOwned = new Set(["register", "status", "stop"]);

  beforeEach(() => {
    registry = new PluginRegistry(botOwned);
  });

  it("registers a command and looks it up by name", () => {
    const result = registry.register([cmd("p1@m1", "autoresearch")]);
    expect(result.registered).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
    expect(registry.lookup("autoresearch")?.pluginName).toBe("p1@m1");
  });

  it("returns undefined for unknown command", () => {
    expect(registry.lookup("nope")).toBeUndefined();
  });

  it("skips plugin command that conflicts with a bot-owned name", () => {
    const result = registry.register([cmd("p1@m1", "status")]);
    expect(result.registered).toHaveLength(0);
    expect(result.skipped).toEqual([
      expect.objectContaining({
        commandName: "status",
        reason: "name-conflicts-with-bot-owned",
      }),
    ]);
    expect(registry.lookup("status")).toBeUndefined();
  });

  it("first-wins between two plugins with the same command name", () => {
    const result = registry.register([
      cmd("p1@m1", "shared"),
      cmd("p2@m1", "shared"),
    ]);
    expect(result.registered).toHaveLength(1);
    expect(result.registered[0]!.pluginName).toBe("p1@m1");
    expect(result.skipped).toEqual([
      expect.objectContaining({
        pluginName: "p2@m1",
        commandName: "shared",
        reason: "name-conflicts-with-prior-plugin",
      }),
    ]);
  });

  it("truncates plugin commands past the 100-command Discord cap (after bot-owned)", () => {
    const many = Array.from({ length: 120 }, (_, i) =>
      cmd("p1@m1", `cmd${i.toString().padStart(3, "0")}`),
    );
    const result = registry.register(many);
    // 100 - 3 bot-owned = 97 plugin commands fit
    expect(result.registered).toHaveLength(97);
    expect(result.skipped.filter((s) => s.reason === "exceeds-100-command-limit"))
      .toHaveLength(120 - 97);
  });

  it("list() returns all currently-registered commands", () => {
    registry.register([cmd("p1@m1", "a"), cmd("p1@m1", "b")]);
    expect(registry.list().map((c) => c.commandName).sort()).toEqual(["a", "b"]);
  });

  it("clear() empties the registry (for /plugins-sync)", () => {
    registry.register([cmd("p1@m1", "a")]);
    registry.clear();
    expect(registry.list()).toEqual([]);
    expect(registry.lookup("a")).toBeUndefined();
  });
});

function param(
  name: string,
  required: boolean,
  originalIndex: number,
  description = name,
): ParsedParam {
  return { name, description, required, originalIndex, type: "text" };
}

function cmdWithParams(
  pluginName: string,
  commandName: string,
  parsedParams: ParsedParam[],
): DiscoveredCommand {
  const pluginShortName = pluginName.includes("@")
    ? pluginName.slice(0, pluginName.indexOf("@"))
    : pluginName;
  return {
    scope: "plugin",
    pluginName,
    pluginShortName,
    pluginInstallPath: `/fake/${pluginShortName}`,
    commandName,
    description: "test",
    parsedParams,
    sourcePath: `/fake/${commandName}.md`,
  };
}

describe("PluginRegistry.toDiscordCommands", () => {
  let registry: PluginRegistry;
  beforeEach(() => {
    registry = new PluginRegistry(new Set());
  });

  it("emits a single optional `args` option when parsedParams is empty", () => {
    registry.register([cmd("p1@m1", "noargs")]);
    const builders = registry.toDiscordCommands();
    expect(builders).toHaveLength(1);
    const json = builders[0]!.toJSON();
    expect(json.name).toBe("noargs");
    expect(json.options).toHaveLength(1);
    expect(json.options![0]).toMatchObject({
      name: "args",
      type: 3, // STRING
      required: false,
    });
  });

  it("emits options for each parsed param", () => {
    registry.register([
      cmdWithParams("p1@m1", "find", [
        param("query", true, 0),
        param("path", false, 1),
      ]),
    ]);
    const json = registry.toDiscordCommands()[0]!.toJSON();
    expect(json.options).toHaveLength(2);
    expect(json.options![0]).toMatchObject({ name: "query", required: true });
    expect(json.options![1]).toMatchObject({ name: "path", required: false });
  });

  it("reorders required params before optional in Discord output", () => {
    registry.register([
      cmdWithParams("p1@m1", "mixed", [
        param("optional_first", false, 0),
        param("required_second", true, 1),
      ]),
    ]);
    const json = registry.toDiscordCommands()[0]!.toJSON();
    expect(json.options!.map((o: any) => o.name)).toEqual([
      "required_second",
      "optional_first",
    ]);
  });

  it("uses the command description as the Discord description", () => {
    registry.register([
      {
        scope: "plugin",
        pluginName: "p1@m1",
        pluginShortName: "p1",
        pluginInstallPath: "/fake/p1",
        commandName: "described",
        description: "A described command.",
        parsedParams: [],
        sourcePath: "/fake/x.md",
      },
    ]);
    const json = registry.toDiscordCommands()[0]!.toJSON();
    expect(json.description).toBe("A described command.");
  });
});

describe("PluginRegistry.toSdkPluginConfig", () => {
  let registry: PluginRegistry;
  beforeEach(() => {
    registry = new PluginRegistry(new Set());
  });

  it("returns empty array when no plugins registered", () => {
    expect(registry.toSdkPluginConfig()).toEqual([]);
  });

  it("emits one entry per distinct plugin install path", () => {
    registry.register([
      {
        scope: "plugin",
        pluginName: "p1@m1",
        pluginShortName: "p1",
        pluginInstallPath: "/fake/p1",
        commandName: "a",
        description: "",
        parsedParams: [],
        sourcePath: "/fake/p1/a.md",
      },
      {
        scope: "plugin",
        pluginName: "p1@m1",
        pluginShortName: "p1",
        pluginInstallPath: "/fake/p1",
        commandName: "b",
        description: "",
        parsedParams: [],
        sourcePath: "/fake/p1/b.md",
      },
      {
        scope: "plugin",
        pluginName: "p2@m1",
        pluginShortName: "p2",
        pluginInstallPath: "/fake/p2",
        commandName: "c",
        description: "",
        parsedParams: [],
        sourcePath: "/fake/p2/c.md",
      },
    ]);
    const cfg = registry.toSdkPluginConfig();
    expect(cfg).toHaveLength(2); // deduped by install path
    expect(cfg.map((e) => e.path).sort()).toEqual(["/fake/p1", "/fake/p2"]);
    for (const e of cfg) expect(e.type).toBe("local");
  });
});
