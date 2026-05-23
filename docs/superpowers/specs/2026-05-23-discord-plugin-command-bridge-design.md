# Discord Plugin Command Bridge — Design Spec

**Date:** 2026-05-23
**Status:** Draft (awaiting review)
**Owner:** leric
**Target repo:** `claudecode-discord`

## Problem

Today, `claudecode-discord` bridges Discord channels to Claude Agent SDK sessions: each channel is `/register`ed to a project directory, and freeform messages flow through `SessionManager` to a Claude session running in that directory. The user has installed the `claude-obsidian` plugin (user-scope), which provides slash commands like `/autoresearch`, `/wiki`, `/save`, `/canvas`. They want to invoke these commands from Discord as **Discord-native slash commands** — appearing in the `/` autocomplete menu with proper parameter UI — rather than typing them as plain text.

Furthermore, the user wants the system to be **plugin-agnostic**: any Claude plugin that ships a `commands/*.md` directory should auto-appear as Discord slash commands at bot startup, without code changes per plugin.

## Goals

- Any installed Claude plugin's `commands/*.md` files automatically register as Discord slash commands on bot startup.
- **Parse `argument-hint:` frontmatter into Discord-native typed named parameters** (same UX as the bot's existing `/register path:…` command), with a sensible fallback when the hint is absent.
- Slash command invocation flows through the existing `SessionManager` streaming/heartbeat/approval/stop-button machinery — no parallel pipeline.
- Existing bot-owned slash commands and freeform-message behavior are 100% preserved.
- New `/plugins-sync` and `/plugins-list` maintenance commands for refresh and visibility.

## Non-Goals

- Exposing plugin **skills** (vs. **commands**) as Discord slash commands. Most plugins ship many skills that aren't designed for one-shot invocation (e.g. `brainstorming`). Only `commands/*.md` are exposed.
- Per-channel slash command scoping. Discord registers commands guild-wide; we don't use Discord's per-channel permissions API.
- **Sub-command parsing.** A `commands/*.md` file maps to one flat Discord slash command. Plugin commands that document sub-modes in their body (e.g. `/canvas new [name]`, `/save concept [name]`) get a single freeform-string parameter the user types the sub-mode into. Discord sub-command groups are out of scope for v1.
- Autocomplete on plugin command parameters. Plugin authors don't currently ship enough metadata to drive autocomplete; future iteration.
- Auto-detection of plugin install/uninstall at runtime. Requires bot restart or manual `/plugins-sync`.
- Namespace collision resolution beyond first-wins + bot-wins. No `<plugin>--<command>` prefixing.

## Architecture

### Data flow

```
[Discord]
    ↓ /autoresearch topic:"AI agents"
    ↓ (or /autoresearch args:"AI agents" if the command has no argument-hint)
[claudecode-discord bot]
    ↓ interaction.ts: dispatch by command name
[PluginCommandBridge]                              ← new
    ↓ reconstruct prompt in declaration order: "/autoresearch AI agents"
[SessionManager.sendMessage(channelId, prompt, replyTarget)]   ← existing, refactored
    ↓ Claude Agent SDK query()
[Claude session in registered project dir]
    ↓ recognizes slash → invokes plugin skill (e.g. autoresearch)
[Stream response back via existing message-edit loop]
```

### Startup sequence (once at bot boot)

1. `PluginDiscovery.scan()` reads the Claude plugin manifest (cross-platform path; see `discovery.ts` notes).
2. For each plugin entry, scan `<installPath>/commands/*.md`.
3. Parse YAML frontmatter (`description`, `argument-hint`) of each file.
4. Filter out commands with invalid Discord names (must match `^[a-z0-9_-]{1,32}$`).
5. Merge with bot-owned commands; on name collision, **bot-owned wins**; on plugin-vs-plugin collision, **first-discovered wins**. Log warnings either way.
6. Push the merged set via `guild.commands.set([...])`.
7. Store registered plugin commands in an in-memory `Map<commandName, RegisteredPluginCommand>`.

### Runtime (slash command invocation)

1. `interaction.ts` receives `ChatInputCommandInteraction`.
2. If `pluginRegistry.has(interaction.commandName)`, dispatch to `PluginCommandBridge`.
3. Guard: channel must be `/register`ed (use existing `db.getProject(channelId)`).
4. Guard: no concurrent session in this channel (use existing `SessionManager.isActive(channelId)`).
5. `await interaction.deferReply()` to extend the 3-second response window.
6. Build prompt: `/${commandName}${args ? ' ' + args : ''}`.
7. Adapt the `ChatInputCommandInteraction` into a `ReplyTarget` (see Component breakdown below).
8. Call `SessionManager.sendMessage(channelId, prompt, replyTarget)`.
9. Existing streaming / heartbeat / tool-approval / stop-button flow handles the rest.

## `argument-hint` Parsing Semantics

The `argument-hint:` frontmatter field is a freeform display string in Claude Code (not a structured schema). The bridge parses it into Discord parameter slots using this grammar:

### Grammar

```
hint     := slot (whitespace+ slot)*
slot     := required | optional
required := "<" name (whitespace description)? ">"
optional := "[" name (whitespace description)? "]"
name     := [a-zA-Z][a-zA-Z0-9_-]*
```

### Examples

| `argument-hint` value | Generated Discord parameters |
|---|---|
| (missing or empty) | `args` (optional string, description: "Free-form arguments") |
| `[topic]` | `topic` (optional string) |
| `<topic>` | `topic` (required string) |
| `<file> [range]` | `file` (required), `range` (optional) |
| `[topic the research topic]` | `topic` (optional, description: "the research topic") |
| `[file] [optional: range]` | `file` (optional), `optional_range` (optional, description: "range") — see Sanitization |

### Sanitization

- Param **name** must match `^[a-z0-9_-]{1,32}$`. Parser lowercases the captured name and replaces invalid chars with `_`. Empty / leading-digit names get prefixed with `arg_`. Names longer than 32 chars are truncated.
- Param **description** is the text after the name within the same bracket pair, trimmed. If empty, falls back to the param name. Truncated to 100 chars.
- Discord requires **required parameters before optional** in declaration order. Parser reorders silently, preserving original index for prompt construction (see Prompt Construction below).
- Max **25 parameters** per Discord command. Parser truncates trailing slots with a warning.
- Duplicate param names get suffixed with `_2`, `_3`, etc.

### Fallback (no `argument-hint`)

When `argument-hint:` is missing or unparseable, the command gets a single optional string parameter named `args` with description "Free-form arguments". This is what `claude-obsidian`'s current 4 commands will get on day one (they currently have no `argument-hint:`).

### Prompt Construction

When a slash command fires:

1. Collect all parameter values **in their original declaration order from `argument-hint`** (not Discord's reordered required-first order).
2. Trim each value; drop empty trailing values.
3. Join remaining values with single spaces.
4. Final prompt: `/${commandName}${joined ? ' ' + joined : ''}`.

Example: `argument-hint: "[file] <range>"` → Discord shows `range` first (required), then `file` (optional). User fills `range=10-20`, `file=foo.md`. Bridge sends to Claude: `/<commandName> foo.md 10-20`.

## Component Breakdown

### New files

**`src/plugins/discovery.ts`** (~150 lines)
- `scanInstalledPlugins(): Promise<DiscoveredCommand[]>`
- Reads the Claude plugin manifest. Path resolution:
  - macOS / Linux: `~/.claude/plugins/installed_plugins.json`
  - Windows: `%USERPROFILE%\.claude\plugins\installed_plugins.json`
  - Use `path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json')` — works cross-platform.
- Validates manifest with zod.
- Iterates plugins in **alphabetical order by plugin key** (e.g. `claude-obsidian@claude-obsidian-marketplace`) so first-wins collisions are deterministic across machines and reboots.
- For each plugin entry, lists `<installPath>/commands/*.md`.
- Parses frontmatter (hand-rolled minimal parser — extract `description` and `argument-hint`, no nested YAML).
- Parses `argument-hint` via `parseArgumentHint(hint: string): ParsedParam[]` (see `argument-hint` Parsing Semantics section). Returns empty array → caller applies the `args` fallback.
- Returns `{ pluginName, pluginShortName, pluginInstallPath, commandName, description, parsedParams: ParsedParam[], sourcePath }[]`.
  - `pluginName`: full marketplace key like `claude-obsidian@claude-obsidian-marketplace`
  - `pluginShortName`: portion before the `@` — used in namespaced command invocation
  - `pluginInstallPath`: passed to SDK `query({ plugins: [{type:'local', path:...}] })`
- Logs warnings for: missing install path, malformed JSON, malformed frontmatter, invalid Discord names, unparseable hint slots, sanitized param names, truncated slots over the 25 limit.

**`src/plugins/argument-hint.ts`** (~70 lines)
- `parseArgumentHint(hint: string): ParsedParam[]`
- Returns `{ name: string, description: string, required: boolean, originalIndex: number }[]` — `originalIndex` is the slot's position in the original hint, used for prompt construction.
- Handles sanitization (name regex, description truncation, duplicate suffixing, 25-param truncation).
- Pure function; no I/O. Heavily unit-tested with the examples table from the spec.

**`src/plugins/registry.ts`** (~110 lines)
- In-memory store: `Map<commandName, RegisteredPluginCommand>`.
- `register(discovered: DiscoveredCommand[])` — merge with bot-owned name set, log conflicts.
- `lookup(name: string)` — for `interaction.ts` dispatch.
- `list()` — for `/plugins-list`.
- `toSdkPluginConfig(): SdkPluginConfig[]` — emit `{ type: 'local', path: pluginInstallPath }` for every distinct plugin in the registry. Called by `session-manager.ts` to populate `query({ plugins: ... })`.
- `toDiscordCommands()` — for each registered command, build a `SlashCommandBuilder`:
  - If `parsedParams.length === 0` → add a single optional string option `args` ("Free-form arguments").
  - Else, **add required params first, then optional** (Discord ordering requirement), each as `addStringOption(opt => opt.setName(...).setDescription(...).setRequired(...))`.
  - Store the original `parsedParams` (with `originalIndex`) alongside the registered entry so the bridge can reconstruct the prompt in declaration order.

**`src/plugins/bridge.ts`** (~90 lines)
- `handlePluginCommand(interaction: ChatInputCommandInteraction, registered: RegisteredPluginCommand)`:
  - Channel-registered guard: `getProject(interaction.channelId)` returns null → `interaction.editReply()` with "channel not registered" message, return.
  - Concurrent-session guard: `sessionManager.isActive(interaction.channelId)` (or equivalent) → `interaction.editReply()` with busy message, return.
  - Note: `client.ts` already called `interaction.deferReply()` before dispatching, so no need to call it here.
  - Build prompt string from `registered.parsedParams`:
    - If `parsedParams.length === 0` → read the single `args` option (may be empty).
    - Else → for each param sorted by `originalIndex`, read `interaction.options.getString(param.name) ?? ''`. Trim, drop empty trailing values, join with single spaces.
    - Final prompt: `/${registered.pluginShortName}:${registered.commandName}${joined ? ' ' + joined : ''}` — **namespaced form** is mandatory (Phase 0 finding). The plugin-short-name is the bit before the `@` in the marketplace key (e.g. `claude-obsidian` from `claude-obsidian@claude-obsidian-marketplace`).
  - `await interaction.editReply(\`Running \\\`${prompt}\\\`\`)` — acknowledge the slash invocation in the slash-command bubble.
  - Fetch the `TextChannel` from `interaction.channel` (or fetchable from client/cache).
  - `await sessionManager.sendMessage(channel, prompt)` — streaming response and tool-approval flow into fresh channel messages, identical to freeform input.
  - On thrown exception during build/dispatch: `interaction.editReply()` with error text. session-manager errors handle themselves through existing finally-block cleanup.

**`src/bot/commands/plugins-sync.ts`** (~40 lines)
- Bot-owned slash command.
- On invocation: re-run discovery, re-register Discord guild commands, reply with diff summary.

**`src/bot/commands/plugins-list.ts`** (~40 lines)
- Bot-owned slash command.
- Replies with Discord embed table: command name, plugin name, status (registered / skipped-conflict / skipped-invalid-name).

### Modified files

**`src/bot/client.ts`**
- Before the `client.on("ready", ...)` callback fires registration: `const discovered = await scanInstalledPlugins(); pluginRegistry.register(discovered);`
- Add each registered plugin command to `commandMap` with an `execute` thunk: `commandMap.set(name, { execute: (i) => handlePluginCommand(i, registered) })`.
- In the existing `rest.put(Routes.applicationGuildCommands(...))` call, change the body from `commands.map(c => c.data.toJSON())` to include both bot-owned and plugin-derived `SlashCommandBuilder.toJSON()` outputs.

**`src/bot/handlers/interaction.ts`** — **no changes required**.

The existing slash-command dispatch lives in `src/bot/client.ts` (lines ~80-96), which uses a uniform `commandMap.get(interaction.commandName).execute(interaction)` pattern. Plugin commands enter that same map at registration time with an `execute` thunk that calls into the bridge, so dispatch is automatic — no special case in any handler.

**`src/claude/session-manager.ts`** — **small focused change** (~5 lines added).

The current signature `sessionManager.sendMessage(channel, prompt)` stays. Streaming, heartbeat, tool-approval, message-edit logic — all untouched.

The single change: the call to `query({ ... options: { cwd, ... } })` around line 221 must additionally include `plugins: pluginRegistry.toSdkPluginConfig()`, which emits an array of `{ type: 'local', path: <installPath> }` entries for every plugin whose commands won registration. Without this, the SDK won't dispatch namespaced plugin commands (Phase 0 finding).

This couples session-manager to the registry's existence, but only via a static import. If the registry is empty (no plugins discovered), `toSdkPluginConfig()` returns `[]` and the SDK behavior is identical to today.

### Unchanged

- DB schema. No new tables/columns. Plugin state rebuilt from disk on each boot.
- `canUseTool` / approval workflow. Slash-invoked sessions go through the same tool-approval UI as freeform.
- AskUserQuestion / button / select-menu handlers.
- All 10 existing bot-owned slash commands.
- `.env` / config. No new env vars.

## Edge Cases & Failure Modes

### Discord-side

| Situation | Behavior |
|---|---|
| Channel not `/register`ed | Ephemeral reply: "This channel is not registered to a project. Run /register first." |
| Channel has active session | Ephemeral reply (reuse existing busy text). |
| Total commands > 95 | At startup, truncate plugin commands (preserve all bot-owned). Log warning. `/plugins-list` flags truncated entries. |
| Invalid Discord name (regex fails) | Filter at discovery, log warning. |
| Description > 100 chars | Truncate to 97 + "…". |

### Filesystem / plugin

| Situation | Behavior |
|---|---|
| `installed_plugins.json` missing | Treat as 0 plugins; bot boots normally with no plugin commands. |
| Malformed JSON | Log error; skip discovery; bot boots normally. |
| Plugin install path missing | Skip plugin; log warning. |
| Plugin has no `commands/` directory | Silent skip (normal case for `superpowers`, `discord`). |
| Malformed frontmatter in a `.md` file | Skip that file; log warning; continue. |

### Argument-hint parsing

| Situation | Behavior |
|---|---|
| `argument-hint:` missing | Apply fallback: single optional `args` parameter. |
| `argument-hint:` is empty string | Apply fallback. |
| Hint has no `<…>` or `[…]` slots (just freeform text) | Apply fallback; log warning naming the command. |
| Hint mixes `<>` and `[]` (required + optional) | Both honored; required reordered to front for Discord. Original index preserved for prompt construction. |
| Slot name has invalid chars / leading digit / empty | Sanitize per rules; log warning. |
| Duplicate slot names within one hint | Suffix duplicates `_2`, `_3`. Log warning. |
| > 25 slots | Truncate trailing slots, log warning. Command still registers. |
| Unclosed bracket (`<topic` or `[file`) | Parser ignores the unclosed slot; if zero valid slots remain, apply fallback. Log warning. |

### Name conflicts

| Situation | Behavior |
|---|---|
| Plugin command name collides with bot-owned | Skip plugin command; log warning. |
| Two plugins ship same command name | First-discovered wins; skip the rest; log warning. `/plugins-list` shows skipped entries. |

### Runtime

| Situation | Behavior |
|---|---|
| `deferReply()` times out (>3s) | Catch `InteractionResponseTimeout`; log; do not proceed. |
| `SessionManager` throws | Catch; `interaction.editReply()` shows error; existing finally-block session cleanup runs. |
| Claude doesn't recognize the slash command (plugin not loaded by SDK) | Bridge passes through. Claude responds however it responds. No client-side detection. |
| Plugin uninstalled while bot running | Slash command stays registered until next `/plugins-sync` or restart. If invoked, Claude session handles the unknown command. |

### Security

| Situation | Behavior |
|---|---|
| Non-whitelisted user fires command | Existing `guard.ts` blocks via `ALLOWED_USER_IDS`. |
| Rate limit | Slash invocations count against the existing sliding-window limiter. |
| Long `args` / prompt injection | Pass through. Existing architecture trusts whitelisted users; this PR doesn't change that posture. |
| Channel registered to non-vault project | No filter. Forward to Claude; if the plugin needs the wrong working dir, Claude will respond accordingly (e.g. "No wiki vault found, run /wiki first"). |

## Critical Open Questions (resolved before code)

1. **Does the Claude Agent SDK recognize `/<command>` text as a slash command and dispatch the plugin's skill, the same way interactive Claude Code does?** — **RESOLVED 2026-05-23.**

   Phase 0 probing established:
   - The SDK does NOT auto-load user-scope plugins. A vanilla `query({ prompt: "/autoresearch ..." })` returns `"Unknown command: /autoresearch"`.
   - The SDK DOES load plugins when caller passes `options.plugins: [{ type: 'local', path: '<installPath>' }]` (or `options.settingSources: ['user']` to read `~/.claude/settings.json`).
   - Loaded plugin commands appear **namespaced**: `claude-obsidian:autoresearch`, not bare `autoresearch`. The bridge must construct prompts as `/<pluginShortName>:<commandName> <args>`.
   - When invoked via the namespaced form, the model receives the skill body (via the `Skill` tool flow) and executes the workflow — same end behavior as interactive CC.

   Design consequence: `session-manager.ts` is no longer "untouched". It must populate `options.plugins` from the registry's known install paths when calling `query()`. This is a small focused change (a few lines), not a refactor — see Component Breakdown for details.

2. **Does `installed_plugins.json` carry a disabled state?**
   - Inspect the file format at Phase 1 implementation time.
   - **If yes:** Filter out disabled plugins in discovery.
   - **If no:** Treat `installed = enabled`. Add a `/plugins-sync --refresh-enabled` knob later if needed.

## Rollout Plan

### Phase 0 — Validate the core assumption (no claudecode-discord code changes)

- Write a throwaway node script that uses `@anthropic-ai/claude-agent-sdk` to send `/autoresearch test` to a session rooted in the `claude-obsidian` vault.
- Confirm the autoresearch skill fires (check log output, tool invocations, wiki file changes).
- **Gate:** If this fails, redesign the bridge to use the fallback strategy (inline command body + args) before any further code is written.

### Phase 1 — Discovery + parser + registry (no Discord integration yet)

- Implement `src/plugins/argument-hint.ts` — pure parser, fully unit-tested with the examples table from the spec plus edge cases (sanitization, dupes, truncation, unclosed brackets).
- Implement `src/plugins/discovery.ts` and `src/plugins/registry.ts`.
- Unit tests covering: empty manifest, malformed JSON, missing install paths, plugin with no `commands/`, plugin with valid commands, name collisions, invalid Discord names, oversized descriptions, fallback when `argument-hint` is missing, mixed required+optional ordering.
- Dev script: `npm run scripts:list-plugin-commands` — prints discovered commands as a table including parsed params.

### Phase 2 — Bridge

- Add `src/plugins/bridge.ts` with `handlePluginCommand`.
- Unit-test guard paths (no registered channel, busy channel) by mocking `getProject` and `sessionManager.isActive`.
- No changes to `session-manager.ts`.

### Phase 3 — Wire up Discord registration

- Update `src/bot/client.ts` startup sequence to run discovery + register both bot-owned and plugin slash commands.
- Plugin commands enter the existing `commandMap` with an `execute` thunk that calls `handlePluginCommand(interaction, registered)`.
- Add `src/bot/commands/plugins-sync.ts` and `src/bot/commands/plugins-list.ts` bot-owned commands.
- Note: existing dispatch in `client.ts` (lines ~80-96) handles slash commands uniformly via `commandMap.get(name).execute()` — no changes to `interaction.ts` handlers needed for the plugin path.

### Phase 4 — End-to-end verification

- `/register` a Discord channel to `claude-obsidian` vault.
- Test cases:
  - `/autoresearch args:"AI agents"` — falls through fallback (no `argument-hint:` yet), runs full pipeline.
  - `/wiki` with empty `args` — runs scaffold/status logic.
  - `/save args:"my insight"` — runs save with title.
  - Add a temporary `argument-hint: "[topic]"` to `autoresearch.md`, run `/plugins-sync`, verify Discord now shows `topic` parameter instead of `args`. `/autoresearch topic:"AI agents"` runs the same prompt.
  - Required+optional mix: temporarily set `argument-hint: "<file> [range]"` on a test command, verify Discord shows `file` first (required), `range` second (optional), and prompt reconstructs in declaration order regardless of fill order.
  - Same commands in an unregistered channel — proper error.
  - Same commands while session is active — proper busy error.
  - `/plugins-sync` after manually editing a `commands/*.md` description — sees update.
  - `/plugins-list` shows correct table including parsed-param column.

## Backward Compatibility

- All 10 existing bot-owned slash commands: untouched.
- Freeform message handling: untouched.
- Tool approval / AskUserQuestion / session resume: untouched.
- DB schema: untouched. No migration.
- `.env`: untouched. No new variables.
- Existing users who upgrade get the new plugin commands; nothing they did before stops working.

## Observability

- `discovery.ts` logs at INFO: `Discovered N plugin commands across M plugins`.
- Conflicts at WARN: `Plugin command /save (from claude-obsidian) skipped — conflicts with bot-owned command`.
- `/plugins-list` returns a Discord embed with full status table.

## Risk Register

| Risk | Mitigation |
|---|---|
| Phase 0 assumption fails | Phase 0 exists specifically to catch this before sunk cost. Fallback strategy documented. |
| `installed_plugins.json` format changes | zod schema validation in discovery; fall back to shelling out `claude plugin list` if structure mismatches. |
| Discord guild command cache lag | `/plugins-sync` documents that propagation can take up to 1 minute; Discord client may need a reload. |
| User installs new plugin and forgets to refresh | `/plugins-sync` is the documented manual refresh; auto-detection deferred to a future iteration. |

## Estimated Effort

- Phase 0: 30 minutes
- Phase 1: 4-5 hours (argument-hint parser + discovery + registry + their test matrix)
- Phase 2: 1-2 hours (bridge — no session-manager refactor needed)
- Phase 3: 2 hours (client.ts wiring + plugins-sync/list commands)
- Phase 4: 1-2 hours (E2E manual verification)
- **Total: 1 working day** (was 1.5-2 days; session-manager untouched saved a chunk)
