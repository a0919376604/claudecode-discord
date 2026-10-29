import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { expect, it } from "vitest";

it("loads .env when a dependency reads config before the application entry runs", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "discord-config-env-"));
  const env = { ...process.env };
  for (const key of ["DISCORD_BOT_TOKEN", "DISCORD_GUILD_ID", "ALLOWED_USER_IDS", "BASE_PROJECT_DIR"]) delete env[key];
  writeFileSync(path.join(dir, ".env"), [
    "DISCORD_BOT_TOKEN=test-token",
    "DISCORD_GUILD_ID=test-guild",
    "ALLOWED_USER_IDS=test-user",
    "BASE_PROJECT_DIR=/test/projects",
  ].join("\n"));
  try {
    const output = execFileSync(process.execPath, [
      "--import", createRequire(import.meta.url).resolve("tsx"), "--input-type=module", "-e",
      `const { getConfig } = await import(${JSON.stringify(new URL("./config.ts", import.meta.url).href)}); console.log(JSON.stringify(getConfig().BASE_PROJECT_DIR));`,
    ], { cwd: dir, env, encoding: "utf8", timeout: 10000 });
    expect(output.trim()).toBe('"/test/projects"');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
