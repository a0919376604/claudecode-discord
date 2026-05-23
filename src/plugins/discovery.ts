import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { parseArgumentHint } from "./argument-hint.js";
import type { DiscoveredCommand } from "./types.js";

const ManifestSchema = z.object({
  version: z.number().optional(),
  plugins: z.record(
    z.string(),
    z.array(
      z.object({
        scope: z.string().optional(),
        installPath: z.string(),
        version: z.string().optional(),
      }).passthrough(),
    ),
  ),
});

const DISCORD_NAME_RE = /^[a-z0-9_-]{1,32}$/;
const MAX_DESC_LEN = 100;

export interface DiscoveryResult {
  commands: DiscoveredCommand[];
  warnings: string[];
}

export interface DiscoveryOptions {
  homeDir?: string;
}

function truncateDescription(desc: string): string {
  if (desc.length <= MAX_DESC_LEN) return desc;
  return desc.slice(0, MAX_DESC_LEN - 3) + "...";
}

/**
 * Minimal frontmatter parser. Extracts `description:` and `argument-hint:`.
 * Returns null if no frontmatter delimiters or required `description:` is
 * absent. Handles quoted values (single or double) and unquoted values.
 */
function parseFrontmatter(
  text: string,
): { description: string; argumentHint?: string } | null {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return null;

  const block = text.slice(3, end);
  const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);

  let description: string | undefined;
  let argumentHint: string | undefined;

  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key === "description") description = value;
    else if (key === "argument-hint") argumentHint = value;
  }

  if (!description) return null;
  return { description, argumentHint };
}

export async function scanInstalledPlugins(
  opts: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const home = opts.homeDir ?? os.homedir();
  const manifestPath = path.join(home, ".claude", "plugins", "installed_plugins.json");
  const warnings: string[] = [];

  if (!fs.existsSync(manifestPath)) {
    return { commands: [], warnings };
  }

  let parsed: z.infer<typeof ManifestSchema>;
  try {
    const raw = fs.readFileSync(manifestPath, "utf8");
    parsed = ManifestSchema.parse(JSON.parse(raw));
  } catch (e) {
    warnings.push(`Failed to parse ${manifestPath}: ${(e as Error).message}`);
    return { commands: [], warnings };
  }

  const commands: DiscoveredCommand[] = [];
  const pluginKeys = Object.keys(parsed.plugins).sort();

  for (const pluginKey of pluginKeys) {
    const entries = parsed.plugins[pluginKey];
    if (!entries || entries.length === 0) continue;
    const installPath = entries[0]!.installPath;

    if (!fs.existsSync(installPath)) {
      warnings.push(`Plugin ${pluginKey}: install path missing (${installPath})`);
      continue;
    }

    const commandsDir = path.join(installPath, "commands");
    if (!fs.existsSync(commandsDir) || !fs.statSync(commandsDir).isDirectory()) {
      continue;
    }

    let files: string[];
    try {
      files = fs.readdirSync(commandsDir);
    } catch (e) {
      warnings.push(`Plugin ${pluginKey}: failed to list commands/: ${(e as Error).message}`);
      continue;
    }

    const pluginShortName = pluginKey.includes("@")
      ? pluginKey.slice(0, pluginKey.indexOf("@"))
      : pluginKey;

    for (const file of files) {
      if (!file.endsWith(".md")) continue;

      const commandName = file.slice(0, -3);
      if (!DISCORD_NAME_RE.test(commandName)) {
        warnings.push(
          `Plugin ${pluginKey}: command name "${commandName}" is not a valid Discord slash command name (must match ${DISCORD_NAME_RE}); skipping`,
        );
        continue;
      }

      const sourcePath = path.join(commandsDir, file);
      let body: string;
      try {
        body = fs.readFileSync(sourcePath, "utf8");
      } catch (e) {
        warnings.push(`Plugin ${pluginKey}/${file}: read failed: ${(e as Error).message}`);
        continue;
      }

      const fm = parseFrontmatter(body);
      if (!fm) {
        warnings.push(`Plugin ${pluginKey}/${file}: missing or malformed frontmatter; skipping`);
        continue;
      }

      const description = truncateDescription(fm.description);
      const parsedParams = fm.argumentHint
        ? parseArgumentHint(fm.argumentHint)
        : [];

      commands.push({
        pluginName: pluginKey,
        pluginShortName,
        pluginInstallPath: installPath,
        commandName,
        description,
        parsedParams,
        sourcePath,
      });
    }
  }

  return { commands, warnings };
}
