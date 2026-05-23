import { describe, it, expect, beforeEach } from "vitest";
import { PluginRegistry } from "./registry.js";
import type { DiscoveredCommand } from "./types.js";

function cmd(
  pluginName: string,
  commandName: string,
  description = "desc",
): DiscoveredCommand {
  const pluginShortName = pluginName.includes("@")
    ? pluginName.slice(0, pluginName.indexOf("@"))
    : pluginName;
  return {
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
