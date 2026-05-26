import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  scanInstalledPlugins,
  scanUserCommands,
  scanProjectCommands,
  scanAllCommandSources,
} from "./discovery.js";

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
      { name: "query", description: "query", required: true, originalIndex: 0, type: "text" },
      { name: "path", description: "path", required: false, originalIndex: 1, type: "path" },
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

  it("tags discovered plugin commands with scope='plugin'", async () => {
    const pluginPath = makePlugin(tmpHome, "p1", {
      "x.md": `---\ndescription: X.\n---`,
    });
    writeManifest(tmpHome, { "p1@m1": pluginPath });
    const result = await scanInstalledPlugins({ homeDir: tmpHome });
    expect(result.commands[0]!.scope).toBe("plugin");
  });
});

describe("scanUserCommands", () => {
  it("returns [] when ~/.claude/commands does not exist", async () => {
    // tmpHome only has .claude/plugins, not .claude/commands
    const result = await scanUserCommands({ homeDir: tmpHome });
    expect(result.commands).toEqual([]);
  });

  it("discovers .md files under ~/.claude/commands and tags them user", async () => {
    const userCmdDir = path.join(tmpHome, ".claude", "commands");
    fs.mkdirSync(userCmdDir, { recursive: true });
    fs.writeFileSync(
      path.join(userCmdDir, "obsidian-init.md"),
      `---\ndescription: Init vault.\n---\nbody`,
    );

    const result = await scanUserCommands({ homeDir: tmpHome });
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]).toMatchObject({
      scope: "user",
      pluginName: "<user>",
      pluginShortName: "",
      pluginInstallPath: "",
      commandName: "obsidian-init",
      description: "Init vault.",
    });
  });

  it("rejects invalid Discord names in user commands too", async () => {
    const userCmdDir = path.join(tmpHome, ".claude", "commands");
    fs.mkdirSync(userCmdDir, { recursive: true });
    fs.writeFileSync(
      path.join(userCmdDir, "Bad_Name.md"),
      `---\ndescription: Bad.\n---`,
    );
    const result = await scanUserCommands({ homeDir: tmpHome });
    expect(result.commands).toEqual([]);
    expect(result.warnings.some((w) => w.includes("Bad_Name"))).toBe(true);
  });
});

describe("scanProjectCommands", () => {
  it("returns [] when <project>/.claude/commands does not exist", async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "proj-"));
    try {
      const result = await scanProjectCommands({ projectPath });
      expect(result.commands).toEqual([]);
    } finally {
      fs.rmSync(projectPath, { recursive: true, force: true });
    }
  });

  it("discovers project commands and stamps projectPath", async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "proj-"));
    try {
      const cmdDir = path.join(projectPath, ".claude", "commands");
      fs.mkdirSync(cmdDir, { recursive: true });
      fs.writeFileSync(
        path.join(cmdDir, "deploy.md"),
        `---\ndescription: Deploy this project.\n---`,
      );

      const result = await scanProjectCommands({ projectPath });
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0]).toMatchObject({
        scope: "project",
        pluginName: "<project>",
        projectPath,
        commandName: "deploy",
      });
    } finally {
      fs.rmSync(projectPath, { recursive: true, force: true });
    }
  });
});

describe("scanAllCommandSources", () => {
  it("aggregates plugin + user + project commands", async () => {
    // Plugin source
    const pluginPath = makePlugin(tmpHome, "p1", {
      "from-plugin.md": `---\ndescription: P.\n---`,
    });
    writeManifest(tmpHome, { "p1@m1": pluginPath });
    // User source
    const userCmdDir = path.join(tmpHome, ".claude", "commands");
    fs.mkdirSync(userCmdDir, { recursive: true });
    fs.writeFileSync(
      path.join(userCmdDir, "from-user.md"),
      `---\ndescription: U.\n---`,
    );
    // Project source
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "proj-"));
    try {
      const projDir = path.join(projectPath, ".claude", "commands");
      fs.mkdirSync(projDir, { recursive: true });
      fs.writeFileSync(
        path.join(projDir, "from-project.md"),
        `---\ndescription: Pj.\n---`,
      );

      const result = await scanAllCommandSources({
        homeDir: tmpHome,
        projectPaths: [projectPath],
      });

      const byName = Object.fromEntries(
        result.commands.map((c) => [c.commandName, c.scope]),
      );
      expect(byName).toEqual({
        "from-plugin": "plugin",
        "from-user": "user",
        "from-project": "project",
      });
    } finally {
      fs.rmSync(projectPath, { recursive: true, force: true });
    }
  });

  it("deduplicates repeated project paths", async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "proj-"));
    try {
      const projDir = path.join(projectPath, ".claude", "commands");
      fs.mkdirSync(projDir, { recursive: true });
      fs.writeFileSync(
        path.join(projDir, "once.md"),
        `---\ndescription: Once.\n---`,
      );

      const result = await scanAllCommandSources({
        homeDir: tmpHome,
        projectPaths: [projectPath, projectPath, projectPath],
      });
      // Even though the same project appears three times in the channel→project
      // mapping, we should only see one "once" command — first-wins through the
      // dedupe guard in scanAllCommandSources.
      expect(result.commands.filter((c) => c.commandName === "once")).toHaveLength(1);
    } finally {
      fs.rmSync(projectPath, { recursive: true, force: true });
    }
  });
});
