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
