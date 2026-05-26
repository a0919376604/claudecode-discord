/**
 * Shared types for the plugin command bridge.
 *
 * See docs/superpowers/specs/2026-05-23-discord-plugin-command-bridge-design.md
 * for the full design, especially the "argument-hint Parsing Semantics" section.
 */

/**
 * One parameter slot extracted from a command's `argument-hint:` frontmatter.
 * `originalIndex` is the slot's position in the source hint string — used to
 * reconstruct the prompt in declaration order even when Discord requires
 * required params to be declared first.
 */
export interface ParsedParam {
  name: string; // sanitized: ^[a-z0-9_-]{1,32}$
  description: string; // <= 100 chars, defaults to name if hint had none
  required: boolean;
  originalIndex: number; // 0-based position in the source hint
  /**
   * "path" → Discord should attach autocomplete listing BASE_PROJECT_DIR
   * subdirs; bridge resolves the value to an absolute path before dispatch.
   * "text" → plain string option, no autocomplete.
   *
   * Set by the parser via name convention (PATH_PARAM_NAMES) or an explicit
   * `<name:path>` / `<name:text>` annotation in the argument-hint. Falls back
   * to "text" when neither matches.
   */
  type: "path" | "text";
}

/**
 * Where a slash command lives on disk. Determines:
 *   - how the bridge builds the Claude prompt
 *     ("plugin" → `/<short>:<cmd>` namespaced; "user"/"project" → bare `/<cmd>`)
 *   - whether the registry passes a `{type:"local",path}` entry to the SDK
 *     `plugins` option (only "plugin"; user/project commands are auto-discovered
 *     by the Claude CLI based on cwd + $HOME)
 *
 * The three locations correspond to Claude Code's own command-resolution
 * scopes: plugin commands ship inside an installed plugin; user commands live
 * at `~/.claude/commands/`; project commands live at
 * `<cwd>/.claude/commands/`.
 */
export type CommandScope = "plugin" | "user" | "project";

/**
 * One slash command discovered on disk.
 *
 * For "plugin" scope, all three plugin-identity fields are real:
 * - `pluginName`: full marketplace key, e.g. "claude-obsidian@claude-obsidian-marketplace"
 * - `pluginShortName`: the part before "@", used in namespaced command invocation
 *   (the SDK exposes plugin commands as "claude-obsidian:autoresearch")
 * - `pluginInstallPath`: absolute path to the plugin install dir, passed into
 *   query({ plugins: [{ type: 'local', path: ... }] }) so the SDK loads it
 *
 * For "user" scope, plugin fields are sentinel-empty:
 * - `pluginName = "<user>"`, `pluginShortName = ""`, `pluginInstallPath = ""`
 *
 * For "project" scope, plugin fields hold project metadata:
 * - `pluginName = "<project>"`, `pluginShortName = ""`, `pluginInstallPath = ""`
 * - `projectPath` is the project root (the cwd that owns this command)
 *
 * Bridge + registry read `scope` (not the sentinel strings) — the sentinels
 * exist only to keep tests/code paths that touched the old schema working.
 */
export interface DiscoveredCommand {
  scope: CommandScope;
  pluginName: string;
  pluginShortName: string;
  pluginInstallPath: string;
  projectPath?: string; // set iff scope === "project"
  commandName: string; // sanitized; matches the .md filename without extension
  description: string; // from frontmatter, truncated to 100 chars
  parsedParams: ParsedParam[]; // empty array → bridge uses single-`args` fallback
  sourcePath: string; // absolute path to the .md file (for debugging)
}

/**
 * A command that has won registration (no name conflict, valid name, fits
 * inside the 100-command Discord limit). Stored in the registry's in-memory
 * map keyed by commandName.
 */
export interface RegisteredPluginCommand extends DiscoveredCommand {
  registeredAt: number; // Date.now() — for /plugins-list display
}

/**
 * An entry that was discovered but didn't make it into Discord registration.
 * Surfaced by /plugins-list so the user can see what was filtered and why.
 *
 * Note: invalid-Discord-name rejections happen in the discovery layer (logged
 * as warnings, not returned here) — by the time a command reaches the registry
 * it already has a valid name. So only name-collision and 100-cap reasons
 * appear in this union.
 */
export interface SkippedPluginCommand {
  pluginName: string;
  commandName: string;
  reason:
    | "name-conflicts-with-bot-owned"
    | "name-conflicts-with-prior-plugin"
    | "exceeds-100-command-limit";
  sourcePath: string;
}
