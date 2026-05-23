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

export interface DiscoveryResult {
  commands: DiscoveredCommand[];
  warnings: string[];
}

export interface DiscoveryOptions {
  homeDir?: string;
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

  const pluginKeys = Object.keys(parsed.plugins).sort();
  for (const _key of pluginKeys) {
    // Phase B will fill in command scanning.
  }

  // Reference unused imports to satisfy noUnusedLocals during Phase A;
  // Phase B will consume these directly.
  void parseArgumentHint;

  return { commands: [], warnings };
}
