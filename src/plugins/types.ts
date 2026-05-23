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
}

/**
 * One command discovered from a plugin's commands/ directory.
 *
 * Three plugin-identity fields are populated:
 * - `pluginName`: full marketplace key, e.g. "claude-obsidian@claude-obsidian-marketplace"
 * - `pluginShortName`: the part before "@", used in namespaced command invocation
 *   (the SDK exposes plugin commands as "claude-obsidian:autoresearch")
 * - `pluginInstallPath`: absolute path to the plugin install dir, passed into
 *   query({ plugins: [{ type: 'local', path: ... }] }) so the SDK loads it
 */
export interface DiscoveredCommand {
  pluginName: string;
  pluginShortName: string;
  pluginInstallPath: string;
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
 */
export interface SkippedPluginCommand {
  pluginName: string;
  commandName: string;
  reason:
    | "name-conflicts-with-bot-owned"
    | "name-conflicts-with-prior-plugin"
    | "invalid-discord-name"
    | "exceeds-100-command-limit";
  sourcePath: string;
}
