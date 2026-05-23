import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { scanInstalledPlugins } from "./discovery.js";

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "discovery-test-"));
  fs.mkdirSync(path.join(tmpHome, ".claude", "plugins"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("scanInstalledPlugins — manifest reading", () => {
  it("returns [] when installed_plugins.json is missing", async () => {
    const result = await scanInstalledPlugins({ homeDir: tmpHome });
    expect(result.commands).toEqual([]);
  });

  it("returns [] when manifest is malformed JSON", async () => {
    fs.writeFileSync(
      path.join(tmpHome, ".claude", "plugins", "installed_plugins.json"),
      "{ this is not json",
    );
    const result = await scanInstalledPlugins({ homeDir: tmpHome });
    expect(result.commands).toEqual([]);
  });

  it("skips plugins whose installPath does not exist on disk", async () => {
    fs.writeFileSync(
      path.join(tmpHome, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "ghost@ghost-marketplace": [
            { scope: "user", installPath: "/nonexistent/path", version: "1.0.0" },
          ],
        },
      }),
    );
    const result = await scanInstalledPlugins({ homeDir: tmpHome });
    expect(result.commands).toEqual([]);
  });

  it("skips plugins with no commands/ directory", async () => {
    const pluginPath = path.join(tmpHome, "fake-plugin");
    fs.mkdirSync(pluginPath, { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "fake@fake-marketplace": [
            { scope: "user", installPath: pluginPath, version: "1.0.0" },
          ],
        },
      }),
    );
    const result = await scanInstalledPlugins({ homeDir: tmpHome });
    expect(result.commands).toEqual([]);
  });
});

function makePlugin(
  root: string,
  name: string,
  files: Record<string, string>,
): string {
  const pluginPath = path.join(root, name);
  const commandsPath = path.join(pluginPath, "commands");
  fs.mkdirSync(commandsPath, { recursive: true });
  for (const [filename, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(commandsPath, filename), content);
  }
  return pluginPath;
}

function writeManifest(home: string, plugins: Record<string, string>) {
  const entry = Object.fromEntries(
    Object.entries(plugins).map(([k, v]) => [
      k,
      [{ scope: "user", installPath: v, version: "1.0.0" }],
    ]),
  );
  fs.writeFileSync(
    path.join(home, ".claude", "plugins", "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: entry }),
  );
}

describe("scanInstalledPlugins — scanning commands/", () => {
  it("discovers one .md file as one command", async () => {
    const pluginPath = makePlugin(tmpHome, "p1", {
      "autoresearch.md": `---\ndescription: Research a topic.\n---\nbody`,
    });
    writeManifest(tmpHome, { "p1@m1": pluginPath });

    const result = await scanInstalledPlugins({ homeDir: tmpHome });
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]).toMatchObject({
      pluginName: "p1@m1",
      pluginShortName: "p1",
      pluginInstallPath: pluginPath,
      commandName: "autoresearch",
      description: "Research a topic.",
      parsedParams: [],
    });
    expect(result.commands[0]!.sourcePath).toContain("autoresearch.md");
  });

  it("derives pluginShortName as the substring before '@'", async () => {
    const pluginPath = makePlugin(tmpHome, "claude-obsidian", {
      "x.md": `---\ndescription: X.\n---`,
    });
    writeManifest(tmpHome, { "claude-obsidian@claude-obsidian-marketplace": pluginPath });

    const result = await scanInstalledPlugins({ homeDir: tmpHome });
    expect(result.commands[0]!.pluginShortName).toBe("claude-obsidian");
  });

  it("uses the full pluginName as pluginShortName when no '@' present", async () => {
    const pluginPath = makePlugin(tmpHome, "noat", {
      "x.md": `---\ndescription: X.\n---`,
    });
    writeManifest(tmpHome, { "noat": pluginPath });

    const result = await scanInstalledPlugins({ homeDir: tmpHome });
    expect(result.commands[0]!.pluginShortName).toBe("noat");
  });

  it("parses argument-hint into parsedParams", async () => {
    const pluginPath = makePlugin(tmpHome, "p1", {
      "find.md": `---\ndescription: Find files.\nargument-hint: "<query> [path]"\n---\nbody`,
    });
    writeManifest(tmpHome, { "p1@m1": pluginPath });

    const result = await scanInstalledPlugins({ homeDir: tmpHome });
    expect(result.commands[0]!.parsedParams).toEqual([
      { name: "query", description: "query", required: true, originalIndex: 0 },
      { name: "path", description: "path", required: false, originalIndex: 1 },
    ]);
  });

  it("skips files with malformed frontmatter", async () => {
    const pluginPath = makePlugin(tmpHome, "p1", {
      "good.md": `---\ndescription: Good.\n---\nbody`,
      "bad.md": `no frontmatter at all`,
    });
    writeManifest(tmpHome, { "p1@m1": pluginPath });

    const result = await scanInstalledPlugins({ homeDir: tmpHome });
    expect(result.commands.map((c) => c.commandName)).toEqual(["good"]);
  });

  it("rejects commands whose filename is not a valid Discord name", async () => {
    const pluginPath = makePlugin(tmpHome, "p1", {
      "Bad_Name.md": `---\ndescription: Bad.\n---\nbody`,
      "valid-name.md": `---\ndescription: OK.\n---\nbody`,
    });
    writeManifest(tmpHome, { "p1@m1": pluginPath });

    const result = await scanInstalledPlugins({ homeDir: tmpHome });
    expect(result.commands.map((c) => c.commandName)).toEqual(["valid-name"]);
    expect(result.warnings.some((w) => w.includes("Bad_Name"))).toBe(true);
  });

  it("truncates descriptions over 100 chars", async () => {
    const long = "x".repeat(150);
    const pluginPath = makePlugin(tmpHome, "p1", {
      "long.md": `---\ndescription: ${long}\n---\nbody`,
    });
    writeManifest(tmpHome, { "p1@m1": pluginPath });

    const result = await scanInstalledPlugins({ homeDir: tmpHome });
    expect(result.commands[0]!.description).toHaveLength(100);
    expect(result.commands[0]!.description.endsWith("...")).toBe(true);
  });

  it("iterates plugins in alphabetical order", async () => {
    const p1 = makePlugin(tmpHome, "zzz", {
      "first.md": `---\ndescription: From zzz.\n---`,
    });
    const p2 = makePlugin(tmpHome, "aaa", {
      "second.md": `---\ndescription: From aaa.\n---`,
    });
    writeManifest(tmpHome, { "zzz@m1": p1, "aaa@m1": p2 });

    const result = await scanInstalledPlugins({ homeDir: tmpHome });
    // aaa@m1 sorts before zzz@m1, so "second" should appear first
    expect(result.commands.map((c) => c.commandName)).toEqual(["second", "first"]);
  });
});
