# Plugin Command Path Autocomplete

**Date:** 2026-05-26
**Status:** Draft — awaiting user review

## Problem

The Discord bot already auto-registers Claude Code skill commands (plugin /
user / project scope) as Discord slash commands via the bridge in
`src/plugins/`. Many of those commands take a repo / project path as an
argument — e.g.:

```markdown
# claude-obsidian's architect command
---
description: Scan a codebase and generate architecture notes
argument-hint: <repo-path>
---
```

Today, the bridge registers every parsed param as a plain
`addStringOption(...)` with no autocomplete. The user must **hand-type** the
full path, even though every repo on this machine lives under
`BASE_PROJECT_DIR`. By contrast, the bot's own `/register` and `/worktree`
commands already provide a Discord-native autocomplete dropdown that walks
`BASE_PROJECT_DIR` subdirectories.

We want plugin-derived slash commands whose argument represents a repo/path
to get the same treatment.

## Goals

1. Plugin commands with a path-typed argument get a `BASE_PROJECT_DIR`
   autocomplete dropdown in Discord — same look and feel as `/register`.
2. The channel's currently-registered project is pinned at the top of the
   list (when the user hasn't started filtering) so the most common case is
   one click.
3. Zero changes required for the **majority** of existing plugins — name
   conventions cover the common case (`<repo>`, `<repo-path>`, `<path>`,
   `<project>`, `<project-path>`, `<dir>`, `<directory>`).
4. Plugins that need to override the inferred type can do so with an
   explicit annotation in `argument-hint`.

## Non-Goals

- No "Create new: ..." entries (these commands run on existing repos).
- No support for `~/...` or `$HOME` expansion (autocomplete doesn't list
  them; user-typed values aren't expanded).
- No new param types beyond `path` and `text` (no `branch`, `url`, etc. —
  YAGNI).
- No change to how the bot dispatches the command to Claude beyond
  resolving the path arg to an absolute filesystem path.
- No change to user-scope / project-scope command resolution semantics in
  the Claude CLI itself.

## Design

### Detection

Two layers, both implemented in `src/plugins/argument-hint.ts`.

**Layer 1 — name convention.** After the existing baseName sanitization, if
the lowercased baseName is in the set:

```typescript
const PATH_PARAM_NAMES = new Set([
  "repo",
  "repo-path",
  "path",
  "project",
  "project-path",
  "dir",
  "directory",
]);
```

then the inferred `type` is `"path"`. Otherwise `"text"`.

**Layer 2 — explicit annotation.** Extend the slot grammar to accept a
`:type` suffix on the param name:

```
slot     := required | optional
required := "<" name (":" type)? (whitespace description)? ">"
optional := "[" name (":" type)? (whitespace description)? "]"
type     := "path" | "text"
```

Examples:

```markdown
argument-hint: <topic:path>          # force path autocomplete on non-conventional name
argument-hint: <path:text>           # force plain text on conventional name
argument-hint: <repo description>    # convention → path (unchanged authoring style)
argument-hint: <topic description>   # convention miss → text (unchanged)
```

If `:type` is present, it overrides the convention. If `type` is anything
other than `path` or `text`, the parser falls back to inferring from the
name (don't error — keep authoring forgiving).

Parser implementation: extend the existing `SLOT_RE` to capture an optional
`:type` token between the name and the description:

```typescript
// Current:
//   /([<\[])\s*([A-Za-z][A-Za-z0-9_-]*)(?:\s+([^<>\[\]]*))?\s*([>\]])/g
// New:
const SLOT_RE =
  /([<\[])\s*([A-Za-z][A-Za-z0-9_-]*)(?:\s*:\s*([A-Za-z][A-Za-z0-9_-]*))?(?:\s+([^<>\[\]]*))?\s*([>\]])/g;
//                                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ new group: optional :type
```

After the match, if the captured `:type` token is `"path"` or `"text"`, use
it as the explicit type. Anything else (including unknown tokens like
`<repo:nope>`) falls back to the name-convention inference — keep authoring
forgiving rather than erroring.

Without this regex extension, an authoring style like `<repo:path>` would
fail to match SLOT_RE entirely (because `:` isn't a valid char in the
current name class and isn't reachable as whitespace-leading description),
which would silently produce an empty `parsedParams`. The extension is
required, not optional.

### Data model

Extend `ParsedParam` in `src/plugins/types.ts`:

```typescript
export interface ParsedParam {
  name: string;
  description: string;
  required: boolean;
  originalIndex: number;
  type: "path" | "text";   // NEW — set by parser via convention or :type annotation; "text" if neither matches
}
```

All existing call sites that destructure `ParsedParam` keep working; only
the registry and bridge consult the new `type` field.

### Shared helper — project directory listing

Today, `src/bot/commands/register.ts` and `src/bot/commands/worktree.ts`
each contain ~50 lines of near-identical autocomplete logic (subdir walk,
nested path support, `.`-prefix filtering, 25-result cap). The bridge would
need the same logic.

Extract once into `src/utils/project-dirs.ts`:

```typescript
export interface ProjectDirChoice {
  name: string;   // display label, e.g. "monorepo/packages-a" or "⭐ my-app"
  value: string;  // value sent in option (relative or absolute path)
}

export interface ListProjectSubdirsOptions {
  focused: string;                  // user's typed text so far
  includeBaseDirSelf?: boolean;     // /register uses true (lists ". (BASE_PROJECT_DIR)");
                                    // /worktree and bridge use false
  includeCreateNew?: boolean;       // /register uses true; bridge & /worktree use false
  starredAbsolutePath?: string;     // channel's registered project (absolute);
                                    // pinned at top when focused is empty
}

export function listProjectSubdirs(
  opts: ListProjectSubdirsOptions,
): ProjectDirChoice[];

export function resolveProjectPath(input: string): string;
// path.isAbsolute(input) ? input : path.join(BASE_PROJECT_DIR, input)
```

`/register`, `/worktree`, and the bridge autocomplete handler all call this
helper. Per-caller config:

| Caller | `includeBaseDirSelf` | `includeCreateNew` | `starredAbsolutePath` |
|---|---|---|---|
| `/register` | `true` | `true` | `undefined` |
| `/worktree` | `false` | `false` | `undefined` |
| plugin bridge | `false` | `false` | channel's registered project, if any |

Dedup between the ⭐ pin and the walk: compare on resolved absolute paths
(not display labels). If the starred project resolves to the same absolute
path as one of the walk entries, drop the walk entry and keep the ⭐ entry
at the top.

### Registry — wiring the autocomplete flag

`src/plugins/registry.ts`, in `toDiscordCommands()`, lines 117–138:

```typescript
for (const p of sorted) {
  builder.addStringOption((opt) => {
    const o = opt
      .setName(p.name)
      .setDescription(p.description)
      .setRequired(p.required);
    if (p.type === "path") o.setAutocomplete(true);
    return o;
  });
}
```

That's the only change in the registry. The fallback `args` option (used
when `parsedParams.length === 0`) does NOT get autocomplete — its semantics
are free-form.

### Bridge — autocomplete handler

Add `handlePluginAutocomplete` to `src/plugins/bridge.ts`:

```typescript
export async function handlePluginAutocomplete(
  interaction: AutocompleteInteraction,
  registry: PluginRegistry,
): Promise<void> {
  const registered = registry.lookup(interaction.commandName);
  if (!registered) return interaction.respond([]);

  const focused = interaction.options.getFocused(true);
  const param = registered.parsedParams.find((p) => p.name === focused.name);
  if (!param || param.type !== "path") return interaction.respond([]);

  const project = getProject(interaction.channelId);
  const choices = listProjectSubdirs({
    focused: focused.value,
    includeCreateNew: false,
    starredAbsolutePath: project?.project_path,
  });

  await interaction.respond(choices.slice(0, 25));
}
```

### Bridge — buildPrompt with path resolution

`src/plugins/bridge.ts` `buildPrompt`, lines 82–85:

```typescript
for (const p of sorted) {
  const raw = (interaction.options.getString(p.name) ?? "").trim();
  if (p.type === "path") {
    if (raw.includes("..")) throw new PathValidationError("path must not contain '..'");
    const resolved = resolveProjectPath(raw);
    if (raw && !path.isAbsolute(raw)) {
      // Validate the relative form stays inside BASE_PROJECT_DIR.
      // Absolute paths are accepted as-is — they come from the ⭐ pin or a
      // power user paste, and match /register's existing tolerance for
      // channels registered outside BASE_PROJECT_DIR.
      const baseDir = path.resolve(BASE_PROJECT_DIR);
      const candidate = path.resolve(resolved);
      if (!candidate.startsWith(baseDir + path.sep) && candidate !== baseDir) {
        throw new PathValidationError("path escapes base project directory");
      }
    }
    values.push(resolved);
  } else {
    values.push(raw);
  }
}
```

`handlePluginCommand` wraps `buildPrompt` in try/catch; on
`PathValidationError`, reply ephemerally with the validation message and
return without dispatching to Claude.

### Client — dispatching autocomplete to the bridge

`src/bot/client.ts` lines 121–129 currently route autocomplete only to
bot-owned commands via `commandMap`. Extend it to fall through to the
plugin registry:

```typescript
if (interaction.isAutocomplete()) {
  const command = commandMap.get(interaction.commandName);
  if (command && "autocomplete" in command) {
    await (command as any).autocomplete(interaction);
    return;
  }
  // Fall through to plugin commands
  if (pluginRegistry.lookup(interaction.commandName)) {
    await handlePluginAutocomplete(interaction, pluginRegistry);
  }
  return;
}
```

### Star pin behavior

The `⭐` pin appears in the dropdown only when:

- The channel has a registered project (`getProject(channelId)` returns a row), **and**
- The user has not started filtering (`focused` is empty).

Once the user begins typing, the `⭐` pin disappears and the list follows
the normal filter — otherwise the user types `foo`, sees the unrelated
starred project at top, and gets confused.

When the starred project lives inside `BASE_PROJECT_DIR`, its relative
path is shown (`⭐ monorepo/foo`). When outside (a channel registered to
an arbitrary absolute path), the absolute path is shown (`⭐ /some/where`).
In either case, the `value` is the absolute path, so the bridge skips the
relative-path validation and dispatches as-is.

Dedup: if the starred project also appears in the subdir walk, the duplicate
is removed from the walk results.

### Error model — `PathValidationError`

A small class exported from `src/utils/project-dirs.ts`:

```typescript
export class PathValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathValidationError";
  }
}
```

The bridge surfaces the message verbatim through `interaction.editReply` so
the user sees `Invalid path: path must not contain '..'` rather than a
generic error.

## Data flow

```
User opens /obsidian-architect in Discord
        ↓
Discord → bot client → interaction.isAutocomplete()
        ↓
client.ts: pluginRegistry.lookup("obsidian-architect") → RegisteredPluginCommand
        ↓
bridge.handlePluginAutocomplete:
   focused param = "repo-path", type === "path"
        ↓
   listProjectSubdirs({ focused: "", starredAbsolutePath: chanProj })
        ↓
Discord shows dropdown:  ⭐ my-app  /  another-repo  /  monorepo  / ...
        ↓
User picks "monorepo/foo"  →  value = "monorepo/foo" (relative)
                              or value = "/abs/path"   (absolute, from ⭐ pin)
        ↓
User submits → interaction.isChatInputCommand()
        ↓
bridge.handlePluginCommand → buildPrompt:
   p.type === "path" → resolveProjectPath → "/Users/leric/Desktop/code/monorepo/foo"
        ↓
sessionManager.sendMessage(channel, "/claude-obsidian:architect /Users/.../foo")
```

## Components

| File | Change |
|---|---|
| `src/plugins/types.ts` | Add `type: "path" \| "text"` to `ParsedParam`. |
| `src/plugins/argument-hint.ts` | Parse `:type` suffix; apply `PATH_PARAM_NAMES` convention; set `type` on each param. |
| `src/plugins/registry.ts` | In `toDiscordCommands()`, call `.setAutocomplete(true)` for `type === "path"`. |
| `src/plugins/bridge.ts` | New `handlePluginAutocomplete`; extend `buildPrompt` to resolve path-typed values; surface `PathValidationError`. |
| `src/utils/project-dirs.ts` (new) | `listProjectSubdirs`, `resolveProjectPath`, `PathValidationError`. |
| `src/bot/commands/register.ts` | Replace inline autocomplete with `listProjectSubdirs({ includeCreateNew: true })`. |
| `src/bot/commands/worktree.ts` | Replace inline autocomplete with `listProjectSubdirs({ includeCreateNew: false })`. |
| `src/bot/client.ts` | Fall through autocomplete dispatch to plugin registry when not bot-owned. |

## Testing

| Test file | What it covers |
|---|---|
| `src/plugins/argument-hint.test.ts` (extend) | `PATH_PARAM_NAMES` convention; `<name:path>` override; `<name:text>` override; unknown `:foo` falls back to convention; existing hints still parse with `type` defaulting via convention/text. |
| `src/plugins/bridge.test.ts` (extend) | `buildPrompt` resolves relative path-typed params; rejects `..`; rejects relative paths escaping `BASE_PROJECT_DIR`; absolute path passes through. |
| `src/plugins/bridge.autocomplete.test.ts` (new — or merge into bridge.test) | Non-path param → empty response; no registered project → no ⭐; channel project outside `BASE_PROJECT_DIR` → ⭐ shows absolute path, no dupe; focused non-empty → no ⭐ pin. |
| `src/utils/project-dirs.test.ts` (new) | Nested walk; `.`-prefix exclusion; 25-cap; `includeCreateNew` flag; ⭐ dedup; `resolveProjectPath` for relative + absolute inputs. |
| `src/bot/commands/sessions.test.ts` (existing) | Regression run — `/register` / `/worktree` still work after extraction. |

## Edge cases

| Situation | Behavior |
|---|---|
| Plugin has no `argument-hint` (falls back to `args`) | No autocomplete. The fallback `args` slot is wired separately in `registry.ts` (not from `parsedParams`); the registry change only adds `setAutocomplete` for parsed params whose `type === "path"`. The `args` slot's name is not in `PATH_PARAM_NAMES` anyway. |
| Plugin has path-typed param but `BASE_PROJECT_DIR` is empty | Dropdown is empty; Discord shows "No options match". |
| User pastes absolute path into path-typed param | Accepted as-is; no boundary check, but `..` still rejected. |
| User types `../foo` | `PathValidationError`; ephemeral reply; no Claude dispatch. |
| Plugin has two path-typed params | Both get autocomplete; handler matches focused by name. |
| Channel's registered project == `BASE_PROJECT_DIR` itself | ⭐ shows as `⭐ .`; value is absolute. |
| `argument-hint` repeats a baseName (`<repo> <repo>`) | Existing dedup adds `_2` suffix; both inherit `type` from the same baseName via convention. |
| Plugin command name collides with bot-owned | Existing registry skip applies; no change. |
| `:type` annotation with an unknown type (`<repo:nope>`) | Parser silently falls back to convention/text — keeps authoring forgiving. |

## Migration / compatibility

- Existing `argument-hint` strings parse unchanged — new `type` field
  defaults via convention or to `"text"`.
- Existing `/register` and `/worktree` semantics unchanged — only the
  autocomplete implementation is refactored to a shared helper.
- No DB schema changes.
- No new env vars.
- No new dependencies.

## Open questions

None outstanding — all design questions resolved during brainstorming.
