import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { parseArgumentHint } from "./argument-hint.js";
import type { CommandScope, DiscoveredCommand } from "./types.js";

const ManifestSchema = z.object({
  version: z.number().optional(),
  plugins: z.record(
    z.string(),
    z.array(
      z.object({
        scope: z.string().optional(),
        installPath: z.string(),
        version: z.string().optional(),
      }).passthrough(), // allow vendor-specific manifest fields (gitCommitSha, lastUpdated, etc.) without erroring
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

export interface ProjectScopeOptions {
  projectPath: string;
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

/**
 * Shared workhorse: read a `commands/` directory and emit DiscoveredCommands.
 *
 * `scopeLabel` is used purely for warning prefixes (so the user can tell from
 * the log whether a malformed file came from a plugin vs ~/.claude/commands
 * vs the project's own commands).
 *
 * `buildIdentity` lets the caller fill in the per-scope identity fields —
 * pluginName/pluginShortName/pluginInstallPath/projectPath — without
 * duplicating the parse logic.
 */
function scanCommandsDir(
  commandsDir: string,
  scope: CommandScope,
  scopeLabel: string,
  buildIdentity: (commandName: string) => Pick<
    DiscoveredCommand,
    "pluginName" | "pluginShortName" | "pluginInstallPath" | "projectPath"
  >,
  warnings: string[],
): DiscoveredCommand[] {
  if (!fs.existsSync(commandsDir) || !fs.statSync(commandsDir).isDirectory()) {
    return [];
  }

  let files: string[];
  try {
    files = fs.readdirSync(commandsDir);
  } catch (e) {
    warnings.push(`${scopeLabel}: failed to list commands/: ${(e as Error).message}`);
    return [];
  }

  const out: DiscoveredCommand[] = [];
  for (const file of files) {
    if (!file.endsWith(".md")) continue;

    const commandName = file.slice(0, -3);
    if (!DISCORD_NAME_RE.test(commandName)) {
      warnings.push(
        `${scopeLabel}: command name "${commandName}" is not a valid Discord slash command name (must match ${DISCORD_NAME_RE}); skipping`,
      );
      continue;
    }

    const sourcePath = path.join(commandsDir, file);
    let body: string;
    try {
      body = fs.readFileSync(sourcePath, "utf8");
    } catch (e) {
      warnings.push(`${scopeLabel}/${file}: read failed: ${(e as Error).message}`);
      continue;
    }

    const fm = parseFrontmatter(body);
    if (!fm) {
      warnings.push(`${scopeLabel}/${file}: missing or malformed frontmatter; skipping`);
      continue;
    }

    const description = truncateDescription(fm.description);
    const parsedParams = fm.argumentHint ? parseArgumentHint(fm.argumentHint) : [];
    const identity = buildIdentity(commandName);

    out.push({
      scope,
      ...identity,
      commandName,
      description,
      parsedParams,
      sourcePath,
    });
  }
  return out;
}

/**
 * Scan installed plugins via `~/.claude/plugins/installed_plugins.json`.
 *
 * This is the ONLY scanner that reads the manifest — user/project scope
 * commands are auto-discovered by the Claude CLI from `~/.claude/commands/`
 * and `<cwd>/.claude/commands/` respectively, so we just scan those dirs
 * directly.
 */
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
    const pluginShortName = pluginKey.includes("@")
      ? pluginKey.slice(0, pluginKey.indexOf("@"))
      : pluginKey;

    const discovered = scanCommandsDir(
      commandsDir,
      "plugin",
      `Plugin ${pluginKey}`,
      () => ({
        pluginName: pluginKey,
        pluginShortName,
        pluginInstallPath: installPath,
      }),
      warnings,
    );
    commands.push(...discovered);
  }

  return { commands, warnings };
}

/**
 * Scan user-scope commands at `~/.claude/commands/`.
 *
 * These are typically dropped in by setup scripts (e.g. obsidian-second-brain
 * init mirrors its commands into here) or written by the user directly. They
 * are NOT listed in `installed_plugins.json` and have no plugin install path.
 *
 * Returned commands have `scope: "user"` and sentinel-empty plugin fields.
 * The bridge invokes them as bare `/<cmd>` (no plugin namespace) because the
 * Claude CLI resolves user-scope commands from $HOME directly.
 */
export async function scanUserCommands(
  opts: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const home = opts.homeDir ?? os.homedir();
  const commandsDir = path.join(home, ".claude", "commands");
  const warnings: string[] = [];

  const commands = scanCommandsDir(
    commandsDir,
    "user",
    "User commands",
    () => ({
      pluginName: "<user>",
      pluginShortName: "",
      pluginInstallPath: "",
    }),
    warnings,
  );

  return { commands, warnings };
}

/**
 * Aggregate discovery across plugin + user + project scopes.
 *
 * Scan order matters: it determines which entry wins when the same command
 * name appears in multiple scopes (the registry uses first-wins).
 *
 * Plugin first, then user, then project — matching the existing precedence:
 * a plugin-shipped `/foo` won't be displaced by a stray `~/.claude/commands/foo.md`.
 * If you want different precedence (e.g. project overrides plugin), reverse
 * the order here; the registry will respect it.
 *
 * `projectPaths` should be the set of currently-registered project roots
 * (one per Discord channel). Pass [] to skip project-scope discovery.
 */
export async function scanAllCommandSources(opts: {
  homeDir?: string;
  projectPaths?: string[];
}): Promise<DiscoveryResult> {
  const commands: DiscoveredCommand[] = [];
  const warnings: string[] = [];

  const plugin = await scanInstalledPlugins({ homeDir: opts.homeDir });
  commands.push(...plugin.commands);
  warnings.push(...plugin.warnings);

  const user = await scanUserCommands({ homeDir: opts.homeDir });
  commands.push(...user.commands);
  warnings.push(...user.warnings);

  // Deduplicate project paths — the bot may have the same project registered
  // under multiple Discord channels; we only need to scan its commands once.
  const seenProjects = new Set<string>();
  for (const p of opts.projectPaths ?? []) {
    if (seenProjects.has(p)) continue;
    seenProjects.add(p);
    const proj = await scanProjectCommands({ projectPath: p });
    commands.push(...proj.commands);
    warnings.push(...proj.warnings);
  }

  return { commands, warnings };
}

/**
 * Scan project-scope commands at `<projectPath>/.claude/commands/`.
 *
 * Project-scope commands are tied to a specific cwd. The bot may serve many
 * projects (one per registered Discord channel), so the caller is expected
 * to invoke this once per registered project and aggregate the results
 * (with first-wins conflict resolution via the registry).
 *
 * Because Discord slash commands are guild-wide and not channel-scoped, if
 * project A and project B both define `/foo`, only one wins the slash slot.
 * The bridge does NOT enforce that the invoking channel matches the
 * project that contributed the command — Claude will resolve `/foo` at
 * runtime based on the dispatching channel's cwd, possibly falling back to
 * a user-scope or plugin-scope command with the same name.
 */
export async function scanProjectCommands(
  opts: ProjectScopeOptions,
): Promise<DiscoveryResult> {
  const commandsDir = path.join(opts.projectPath, ".claude", "commands");
  const warnings: string[] = [];

  const commands = scanCommandsDir(
    commandsDir,
    "project",
    `Project ${opts.projectPath}`,
    () => ({
      pluginName: "<project>",
      pluginShortName: "",
      pluginInstallPath: "",
      projectPath: opts.projectPath,
    }),
    warnings,
  );

  return { commands, warnings };
}
