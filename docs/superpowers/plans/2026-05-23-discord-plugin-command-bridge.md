# Discord Plugin Command Bridge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `claudecode-discord` auto-discover any installed Claude plugin's `commands/*.md` files and expose them as native Discord slash commands (with parsed `argument-hint` parameters), so `/autoresearch`, `/wiki`, `/save`, `/canvas` and friends become first-class Discord commands.

**Architecture:** New `src/plugins/` module with four focused files: `argument-hint.ts` (pure parser), `discovery.ts` (filesystem scan), `registry.ts` (in-memory store + Discord schema builder), `bridge.ts` (Discord interaction → existing `sessionManager.sendMessage`). Plugin commands enter the existing `commandMap` in `client.ts` via `execute` thunks — no changes to `session-manager.ts` or `interaction.ts`. Two new bot-owned commands: `/plugins-sync` (re-scan and re-register) and `/plugins-list` (show registered/skipped).

**Tech Stack:** TypeScript (ESM, strict), discord.js v14, Vitest, zod v4, Claude Agent SDK 0.2.x. Tests co-located with source as `*.test.ts`.

**Spec:** `docs/superpowers/specs/2026-05-23-discord-plugin-command-bridge-design.md`

---

## File Map

**New:**
- `src/plugins/types.ts` — shared types (`ParsedParam`, `DiscoveredCommand`, `RegisteredPluginCommand`)
- `src/plugins/argument-hint.ts` — pure parser
- `src/plugins/argument-hint.test.ts`
- `src/plugins/discovery.ts` — filesystem scan + frontmatter parse
- `src/plugins/discovery.test.ts`
- `src/plugins/registry.ts` — in-memory store + Discord SlashCommandBuilder emitter
- `src/plugins/registry.test.ts`
- `src/plugins/bridge.ts` — handles plugin slash interactions
- `src/plugins/bridge.test.ts`
- `src/bot/commands/plugins-sync.ts`
- `src/bot/commands/plugins-list.ts`
- `scripts/list-plugin-commands.ts` — dev script invoked via `npm run scripts:list-plugin-commands`

**Modified:**
- `src/bot/client.ts` — call discovery at boot, register plugin commands in `commandMap` and Discord guild commands
- `package.json` — add `scripts:list-plugin-commands` npm script

**Unchanged:**
- `src/claude/session-manager.ts`
- `src/bot/handlers/interaction.ts`
- `src/bot/handlers/message.ts`
- DB schema, `.env`, all 12 existing bot commands

---

## Task 0: Validate Claude Agent SDK accepts slash command text (Phase 0 gate)

**Critical: do not proceed past this task if it fails.** The entire bridge design assumes that sending text like `"/autoresearch test"` to the Agent SDK (with a `cwd` rooted in the claude-obsidian vault) triggers the autoresearch plugin skill the same way interactive `claude` does. We need to confirm that before writing any code.

**Files:**
- Create (throwaway, NOT committed): `/tmp/probe-slash.mjs`

- [ ] **Step 1: Write the probe script**

Create `/tmp/probe-slash.mjs`:

```js
import { query } from "@anthropic-ai/claude-agent-sdk";

const vaultPath = "/Users/leric/Desktop/code/claude-obsidian";
console.log("Sending '/autoresearch test topic' to a session rooted at", vaultPath);

const q = query({
  prompt: "/autoresearch test topic",
  options: { cwd: vaultPath },
});

for await (const event of q) {
  console.log(JSON.stringify(event, null, 2).slice(0, 800));
}
```

- [ ] **Step 2: Run the probe from inside claudecode-discord (uses its installed SDK)**

Run:
```bash
cd /Users/leric/Desktop/code/claudecode-discord
node /tmp/probe-slash.mjs 2>&1 | tee /tmp/probe-slash.log
```

- [ ] **Step 3: Interpret the result**

Look for **either** of these signals in `/tmp/probe-slash.log` that confirm the autoresearch skill fired:
- A `tool_use` event invoking `Skill` with name like `"autoresearch"`.
- Streamed assistant text referencing web search, vault writes, or the autoresearch program from `skills/autoresearch/references/program.md`.

**If you see those signals → proceed to Task 1.**

**If you only see Claude saying something like "I don't recognize that command" or treating the text literally → STOP.** The fallback strategy (read command body, inline args, send as a system-like prompt) needs to be designed before continuing. Surface this back to the spec author.

- [ ] **Step 4: Delete the probe script**

```bash
rm /tmp/probe-slash.mjs /tmp/probe-slash.log
```

Nothing to commit yet (no repo changes).

---

## Task 1: Create shared types

**Files:**
- Create: `src/plugins/types.ts`

- [ ] **Step 1: Write the types file**

Create `src/plugins/types.ts`:

```ts
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
 */
export interface DiscoveredCommand {
  pluginName: string; // e.g. "claude-obsidian@claude-obsidian-marketplace"
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
```

- [ ] **Step 2: Verify TypeScript compiles**

Run:
```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/plugins/types.ts
git commit -m "Add shared types for plugin command bridge"
```

---

## Task 2: argument-hint parser — scaffold + empty-input cases

**Files:**
- Create: `src/plugins/argument-hint.ts`
- Create: `src/plugins/argument-hint.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/plugins/argument-hint.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseArgumentHint } from "./argument-hint.js";

describe("parseArgumentHint — empty cases", () => {
  it("returns [] for empty string", () => {
    expect(parseArgumentHint("")).toEqual([]);
  });

  it("returns [] for whitespace-only string", () => {
    expect(parseArgumentHint("   ")).toEqual([]);
  });

  it("returns [] for hint with no bracketed slots (freeform text only)", () => {
    expect(parseArgumentHint("just some words")).toEqual([]);
  });
});
```

- [ ] **Step 2: Write the parser scaffold**

Create `src/plugins/argument-hint.ts`:

```ts
import type { ParsedParam } from "./types.js";

/**
 * Parse a `argument-hint:` frontmatter value into Discord parameter slots.
 *
 * Grammar:
 *   hint     := slot (whitespace+ slot)*
 *   slot     := required | optional
 *   required := "<" name (whitespace description)? ">"
 *   optional := "[" name (whitespace description)? "]"
 *
 * Returns an empty array when the hint is empty, whitespace, or contains no
 * bracketed slots — the caller falls back to a single `args` parameter.
 *
 * See spec for full semantics including sanitization, dupes, 25-param cap,
 * and unclosed-bracket handling. This function is pure (no I/O, no logging
 * side effects beyond the returned warnings list, if added later).
 */
export function parseArgumentHint(hint: string): ParsedParam[] {
  if (!hint || !hint.trim()) return [];
  return [];
}
```

- [ ] **Step 3: Run tests, verify they pass**

Run:
```bash
npx vitest run src/plugins/argument-hint.test.ts
```
Expected: 3 tests PASS (the scaffold returns `[]` which matches all three current expectations).

- [ ] **Step 4: Commit**

```bash
git add src/plugins/argument-hint.ts src/plugins/argument-hint.test.ts
git commit -m "Scaffold argument-hint parser with empty-input cases"
```

---

## Task 3: argument-hint parser — single-slot extraction (optional + required)

**Files:**
- Modify: `src/plugins/argument-hint.test.ts`
- Modify: `src/plugins/argument-hint.ts`

- [ ] **Step 1: Add failing tests**

Append to `src/plugins/argument-hint.test.ts`:

```ts
describe("parseArgumentHint — single slot", () => {
  it("parses [topic] as one optional param", () => {
    expect(parseArgumentHint("[topic]")).toEqual([
      { name: "topic", description: "topic", required: false, originalIndex: 0 },
    ]);
  });

  it("parses <topic> as one required param", () => {
    expect(parseArgumentHint("<topic>")).toEqual([
      { name: "topic", description: "topic", required: true, originalIndex: 0 },
    ]);
  });

  it("ignores leading/trailing whitespace around a single slot", () => {
    expect(parseArgumentHint("  [file]  ")).toEqual([
      { name: "file", description: "file", required: false, originalIndex: 0 },
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
npx vitest run src/plugins/argument-hint.test.ts
```
Expected: FAIL — three new tests fail because the parser still returns `[]`.

- [ ] **Step 3: Implement single-slot extraction**

Replace `parseArgumentHint` in `src/plugins/argument-hint.ts`:

```ts
import type { ParsedParam } from "./types.js";

// Matches a single slot: [name] or <name> with optional description after name.
// Captures: full bracket pair (with surrounding < > or [ ]), then name token,
// then optional description text inside the same brackets.
const SLOT_RE = /([<\[])\s*([A-Za-z][A-Za-z0-9_-]*)(?:\s+([^>\]]*))?\s*([>\]])/g;

export function parseArgumentHint(hint: string): ParsedParam[] {
  if (!hint || !hint.trim()) return [];

  const params: ParsedParam[] = [];
  let match: RegExpExecArray | null;
  let index = 0;

  SLOT_RE.lastIndex = 0;
  while ((match = SLOT_RE.exec(hint)) !== null) {
    const [, openBracket, rawName, rawDesc = "", closeBracket] = match;
    // Bracket pair must match (no mixing < with ])
    const isRequired = openBracket === "<" && closeBracket === ">";
    const isOptional = openBracket === "[" && closeBracket === "]";
    if (!isRequired && !isOptional) continue;

    const name = rawName.toLowerCase();
    const description = rawDesc.trim() || name;

    params.push({
      name,
      description,
      required: isRequired,
      originalIndex: index,
    });
    index++;
  }

  return params;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
npx vitest run src/plugins/argument-hint.test.ts
```
Expected: all 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/plugins/argument-hint.ts src/plugins/argument-hint.test.ts
git commit -m "Parse single optional/required slot from argument-hint"
```

---

## Task 4: argument-hint parser — multiple slots, descriptions, mixed required/optional

**Files:**
- Modify: `src/plugins/argument-hint.test.ts`
- (parser likely already handles these — tests are mostly verification)

- [ ] **Step 1: Add failing tests**

Append to `src/plugins/argument-hint.test.ts`:

```ts
describe("parseArgumentHint — multiple slots", () => {
  it("parses '<file> [range]' as required then optional", () => {
    expect(parseArgumentHint("<file> [range]")).toEqual([
      { name: "file", description: "file", required: true, originalIndex: 0 },
      { name: "range", description: "range", required: false, originalIndex: 1 },
    ]);
  });

  it("parses inline descriptions inside the same bracket pair", () => {
    expect(parseArgumentHint("[topic the research topic]")).toEqual([
      {
        name: "topic",
        description: "the research topic",
        required: false,
        originalIndex: 0,
      },
    ]);
  });

  it("preserves original index even when required appears after optional", () => {
    expect(parseArgumentHint("[range] <file>")).toEqual([
      { name: "range", description: "range", required: false, originalIndex: 0 },
      { name: "file", description: "file", required: true, originalIndex: 1 },
    ]);
  });

  it("handles three mixed slots", () => {
    expect(parseArgumentHint("<a> [b banana] <c>")).toEqual([
      { name: "a", description: "a", required: true, originalIndex: 0 },
      { name: "b", description: "banana", required: false, originalIndex: 1 },
      { name: "c", description: "c", required: true, originalIndex: 2 },
    ]);
  });
});
```

- [ ] **Step 2: Run tests**

Run:
```bash
npx vitest run src/plugins/argument-hint.test.ts
```
Expected: all 10 tests PASS (the regex from Task 3 already handles these — these tests just lock the behavior in).

If any fail, debug the regex before continuing. Most likely failure: the description capture group doesn't strip trailing whitespace correctly. Fix in `argument-hint.ts` if so.

- [ ] **Step 3: Commit**

```bash
git add src/plugins/argument-hint.test.ts
git commit -m "Verify multi-slot and inline-description argument-hint parsing"
```

---

## Task 5: argument-hint parser — sanitization edge cases

**Files:**
- Modify: `src/plugins/argument-hint.test.ts`
- Modify: `src/plugins/argument-hint.ts`

- [ ] **Step 1: Add failing tests**

Append to `src/plugins/argument-hint.test.ts`:

```ts
describe("parseArgumentHint — sanitization", () => {
  it("lowercases param names", () => {
    expect(parseArgumentHint("[Topic]")).toEqual([
      { name: "topic", description: "topic", required: false, originalIndex: 0 },
    ]);
  });

  it("suffixes duplicate names with _2, _3", () => {
    expect(parseArgumentHint("[name] [name] [name]")).toEqual([
      { name: "name", description: "name", required: false, originalIndex: 0 },
      { name: "name_2", description: "name", required: false, originalIndex: 1 },
      { name: "name_3", description: "name", required: false, originalIndex: 2 },
    ]);
  });

  it("truncates descriptions over 100 chars to 97 + '...'", () => {
    const long = "x".repeat(150);
    const result = parseArgumentHint(`[topic ${long}]`);
    expect(result).toHaveLength(1);
    expect(result[0]!.description).toHaveLength(100);
    expect(result[0]!.description.endsWith("...")).toBe(true);
  });

  it("truncates after 25 slots and ignores the rest", () => {
    const slots = Array.from({ length: 30 }, (_, i) => `[p${i}]`).join(" ");
    const result = parseArgumentHint(slots);
    expect(result).toHaveLength(25);
    expect(result[24]!.name).toBe("p24");
  });

  it("ignores unclosed brackets", () => {
    expect(parseArgumentHint("[topic <unclosed [file]")).toEqual([
      // "<unclosed [file]" gets matched as <unclosed ... > ? No — regex requires
      // matching brackets. Only "[file]" should survive.
      { name: "file", description: "file", required: false, originalIndex: 0 },
    ]);
  });

  it("ignores slots with mismatched brackets ([name>)", () => {
    expect(parseArgumentHint("[name>")).toEqual([]);
  });

  it("ignores slots starting with a digit", () => {
    // Regex name pattern requires leading [A-Za-z], so this just doesn't match.
    expect(parseArgumentHint("[1foo]")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to see which fail**

Run:
```bash
npx vitest run src/plugins/argument-hint.test.ts
```
Expected to fail: `duplicate names`, `description truncation`, `25-slot cap`. Others should already pass because the regex naturally rejects them.

- [ ] **Step 3: Add sanitization to the parser**

Replace `parseArgumentHint` body in `src/plugins/argument-hint.ts`:

```ts
import type { ParsedParam } from "./types.js";

const SLOT_RE = /([<\[])\s*([A-Za-z][A-Za-z0-9_-]*)(?:\s+([^>\]]*))?\s*([>\]])/g;
const MAX_PARAMS = 25;
const MAX_DESC_LEN = 100;

function truncateDescription(desc: string): string {
  if (desc.length <= MAX_DESC_LEN) return desc;
  return desc.slice(0, MAX_DESC_LEN - 3) + "...";
}

export function parseArgumentHint(hint: string): ParsedParam[] {
  if (!hint || !hint.trim()) return [];

  const params: ParsedParam[] = [];
  const seenNames = new Map<string, number>(); // base name -> count
  let match: RegExpExecArray | null;
  let index = 0;

  SLOT_RE.lastIndex = 0;
  while ((match = SLOT_RE.exec(hint)) !== null) {
    if (params.length >= MAX_PARAMS) break;

    const [, openBracket, rawName, rawDesc = "", closeBracket] = match;
    const isRequired = openBracket === "<" && closeBracket === ">";
    const isOptional = openBracket === "[" && closeBracket === "]";
    if (!isRequired && !isOptional) continue;

    const baseName = rawName.toLowerCase();
    const seen = seenNames.get(baseName) ?? 0;
    seenNames.set(baseName, seen + 1);
    const name = seen === 0 ? baseName : `${baseName}_${seen + 1}`;

    const description = truncateDescription(rawDesc.trim() || baseName);

    params.push({
      name,
      description,
      required: isRequired,
      originalIndex: index,
    });
    index++;
  }

  return params;
}
```

- [ ] **Step 4: Run tests to verify they all pass**

Run:
```bash
npx vitest run src/plugins/argument-hint.test.ts
```
Expected: all ~17 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/plugins/argument-hint.ts src/plugins/argument-hint.test.ts
git commit -m "Add sanitization (lowercasing, dupes, 25-cap, 100-char descriptions) to argument-hint parser"
```

---

## Task 6: discovery — read installed_plugins.json

**Files:**
- Create: `src/plugins/discovery.ts`
- Create: `src/plugins/discovery.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/plugins/discovery.test.ts`:

```ts
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
```

- [ ] **Step 2: Write the discovery scaffold**

Create `src/plugins/discovery.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { parseArgumentHint } from "./argument-hint.js";
import type { DiscoveredCommand } from "./types.js";

// Schema for ~/.claude/plugins/installed_plugins.json — see the file format
// section of the spec.
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
  warnings: string[]; // human-readable, for logging by the caller
}

export interface DiscoveryOptions {
  homeDir?: string; // override for tests; defaults to os.homedir()
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

  // Alphabetical iteration so first-wins collisions are deterministic.
  const pluginKeys = Object.keys(parsed.plugins).sort();

  // Stubbed for this task — Task 7 fills in command scanning.
  for (const _key of pluginKeys) {
    // intentionally empty for now
  }

  return { commands: [], warnings };
}
```

- [ ] **Step 3: Run tests to verify they pass**

Run:
```bash
npx vitest run src/plugins/discovery.test.ts
```
Expected: all 4 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/plugins/discovery.ts src/plugins/discovery.test.ts
git commit -m "discovery: read installed_plugins.json with graceful failures"
```

---

## Task 7: discovery — scan commands/ + parse frontmatter

**Files:**
- Modify: `src/plugins/discovery.test.ts`
- Modify: `src/plugins/discovery.ts`

- [ ] **Step 1: Add failing tests**

Append to `src/plugins/discovery.test.ts`:

```ts
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
  // plugins: { "plugin-key": installPath }
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
      commandName: "autoresearch",
      description: "Research a topic.",
      parsedParams: [],
    });
    expect(result.commands[0]!.sourcePath).toContain("autoresearch.md");
  });

  it("parses argument-hint into parsedParams", async () => {
    const pluginPath = makePlugin(tmpHome, "p1", {
      "find.md": `---\ndescription: Find files.\nargument-hint: "<query> [path]"\n---\nbody`,
    });
    writeManifest(tmpHome, { "p1@m1": pluginPath });

    const result = await scanInstalledPlugins({ homeDir: tmpHome });
    expect(result.commands[0]!.parsedParams).toEqual([
      { name: "query", description: "query", required: true, originalIndex: 0 },
      { name: "path", description: "path", required: false, originalIndex: 1 },
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
      "Bad_Name.md": `---\ndescription: Bad.\n---\nbody`, // uppercase invalid
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
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run:
```bash
npx vitest run src/plugins/discovery.test.ts
```
Expected: 6 new tests FAIL (current scaffold returns `[]`).

- [ ] **Step 3: Implement command scanning + frontmatter parse**

Replace the entire `src/plugins/discovery.ts`:

```ts
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
 * Returns null if no frontmatter delimiters or required `description:` are
 * present. Handles quoted values (single or double) and unquoted values.
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

    // Strip matched single or double quotes if they wrap the entire value.
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
    // Use the first install entry (user-scope generally comes first; we don't
    // need to discriminate further since both scopes point at the same files).
    const installPath = entries[0]!.installPath;

    if (!fs.existsSync(installPath)) {
      warnings.push(`Plugin ${pluginKey}: install path missing (${installPath})`);
      continue;
    }

    const commandsDir = path.join(installPath, "commands");
    if (!fs.existsSync(commandsDir) || !fs.statSync(commandsDir).isDirectory()) {
      continue; // normal — many plugins have no commands/
    }

    let files: string[];
    try {
      files = fs.readdirSync(commandsDir);
    } catch (e) {
      warnings.push(`Plugin ${pluginKey}: failed to list commands/: ${(e as Error).message}`);
      continue;
    }

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
        commandName,
        description,
        parsedParams,
        sourcePath,
      });
    }
  }

  return { commands, warnings };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
npx vitest run src/plugins/discovery.test.ts
```
Expected: all 10 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/plugins/discovery.ts src/plugins/discovery.test.ts
git commit -m "discovery: scan commands/ and parse frontmatter into DiscoveredCommand"
```

---

## Task 8: registry — register, lookup, conflict resolution

**Files:**
- Create: `src/plugins/registry.ts`
- Create: `src/plugins/registry.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/plugins/registry.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { PluginRegistry } from "./registry.js";
import type { DiscoveredCommand } from "./types.js";

function cmd(
  pluginName: string,
  commandName: string,
  description = "desc",
): DiscoveredCommand {
  return {
    pluginName,
    commandName,
    description,
    parsedParams: [],
    sourcePath: `/fake/${pluginName}/${commandName}.md`,
  };
}

describe("PluginRegistry", () => {
  let registry: PluginRegistry;
  const botOwned = new Set(["register", "status", "stop"]);

  beforeEach(() => {
    registry = new PluginRegistry(botOwned);
  });

  it("registers a command and looks it up by name", () => {
    const result = registry.register([cmd("p1", "autoresearch")]);
    expect(result.registered).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
    expect(registry.lookup("autoresearch")?.pluginName).toBe("p1");
  });

  it("returns undefined for unknown command", () => {
    expect(registry.lookup("nope")).toBeUndefined();
  });

  it("skips plugin command that conflicts with a bot-owned name", () => {
    const result = registry.register([cmd("p1", "status")]);
    expect(result.registered).toHaveLength(0);
    expect(result.skipped).toEqual([
      expect.objectContaining({
        commandName: "status",
        reason: "name-conflicts-with-bot-owned",
      }),
    ]);
    expect(registry.lookup("status")).toBeUndefined();
  });

  it("first-wins between two plugins with the same command name", () => {
    const result = registry.register([
      cmd("p1", "shared"),
      cmd("p2", "shared"),
    ]);
    expect(result.registered).toHaveLength(1);
    expect(result.registered[0]!.pluginName).toBe("p1");
    expect(result.skipped).toEqual([
      expect.objectContaining({
        pluginName: "p2",
        commandName: "shared",
        reason: "name-conflicts-with-prior-plugin",
      }),
    ]);
  });

  it("truncates plugin commands past the 100-command Discord cap (after bot-owned)", () => {
    const many = Array.from({ length: 120 }, (_, i) =>
      cmd("p1", `cmd${i.toString().padStart(3, "0")}`),
    );
    const result = registry.register(many);
    // 100 - 3 bot-owned = 97 plugin commands fit
    expect(result.registered).toHaveLength(97);
    expect(result.skipped.filter((s) => s.reason === "exceeds-100-command-limit"))
      .toHaveLength(120 - 97);
  });

  it("list() returns all currently-registered commands", () => {
    registry.register([cmd("p1", "a"), cmd("p1", "b")]);
    expect(registry.list().map((c) => c.commandName).sort()).toEqual(["a", "b"]);
  });

  it("clear() empties the registry (for /plugins-sync)", () => {
    registry.register([cmd("p1", "a")]);
    registry.clear();
    expect(registry.list()).toEqual([]);
    expect(registry.lookup("a")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Write the registry implementation**

Create `src/plugins/registry.ts`:

```ts
import type {
  DiscoveredCommand,
  RegisteredPluginCommand,
  SkippedPluginCommand,
} from "./types.js";

const DISCORD_GUILD_COMMAND_CAP = 100;

export interface RegisterResult {
  registered: RegisteredPluginCommand[];
  skipped: SkippedPluginCommand[];
}

/**
 * In-memory store of plugin commands that have won registration. Tracks
 * skipped commands for /plugins-list visibility.
 *
 * Constructed with the set of bot-owned slash command names so it can detect
 * collisions and skip the plugin command (bot-owned always wins).
 */
export class PluginRegistry {
  private store = new Map<string, RegisteredPluginCommand>();
  private skipped: SkippedPluginCommand[] = [];

  constructor(private readonly botOwnedNames: Set<string>) {}

  register(discovered: DiscoveredCommand[]): RegisterResult {
    // Reset skipped list on each register call so /plugins-sync reflects only
    // the latest scan.
    this.skipped = [];

    for (const cmd of discovered) {
      if (this.botOwnedNames.has(cmd.commandName)) {
        this.skipped.push({
          pluginName: cmd.pluginName,
          commandName: cmd.commandName,
          reason: "name-conflicts-with-bot-owned",
          sourcePath: cmd.sourcePath,
        });
        continue;
      }

      if (this.store.has(cmd.commandName)) {
        this.skipped.push({
          pluginName: cmd.pluginName,
          commandName: cmd.commandName,
          reason: "name-conflicts-with-prior-plugin",
          sourcePath: cmd.sourcePath,
        });
        continue;
      }

      const totalSlots = this.botOwnedNames.size + this.store.size;
      if (totalSlots >= DISCORD_GUILD_COMMAND_CAP) {
        this.skipped.push({
          pluginName: cmd.pluginName,
          commandName: cmd.commandName,
          reason: "exceeds-100-command-limit",
          sourcePath: cmd.sourcePath,
        });
        continue;
      }

      this.store.set(cmd.commandName, {
        ...cmd,
        registeredAt: Date.now(),
      });
    }

    return {
      registered: this.list(),
      skipped: [...this.skipped],
    };
  }

  lookup(commandName: string): RegisteredPluginCommand | undefined {
    return this.store.get(commandName);
  }

  list(): RegisteredPluginCommand[] {
    return Array.from(this.store.values());
  }

  skippedList(): SkippedPluginCommand[] {
    return [...this.skipped];
  }

  clear(): void {
    this.store.clear();
    this.skipped = [];
  }
}
```

- [ ] **Step 3: Run tests to verify they pass**

Run:
```bash
npx vitest run src/plugins/registry.test.ts
```
Expected: all 7 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/plugins/registry.ts src/plugins/registry.test.ts
git commit -m "registry: in-memory store with bot-collision and first-wins conflict resolution"
```

---

## Task 9: registry — `toDiscordCommands` builder

**Files:**
- Modify: `src/plugins/registry.test.ts`
- Modify: `src/plugins/registry.ts`

- [ ] **Step 1: Add failing tests**

Append to `src/plugins/registry.test.ts`:

```ts
import { SlashCommandBuilder } from "discord.js";
import type { ParsedParam } from "./types.js";

function param(
  name: string,
  required: boolean,
  originalIndex: number,
  description = name,
): ParsedParam {
  return { name, description, required, originalIndex };
}

function cmdWithParams(
  pluginName: string,
  commandName: string,
  parsedParams: ParsedParam[],
): DiscoveredCommand {
  return {
    pluginName,
    commandName,
    description: "test",
    parsedParams,
    sourcePath: `/fake/${commandName}.md`,
  };
}

describe("PluginRegistry.toDiscordCommands", () => {
  let registry: PluginRegistry;
  beforeEach(() => {
    registry = new PluginRegistry(new Set());
  });

  it("emits a single optional `args` option when parsedParams is empty", () => {
    registry.register([cmd("p1", "noargs")]);
    const builders = registry.toDiscordCommands();
    expect(builders).toHaveLength(1);
    const json = builders[0]!.toJSON();
    expect(json.name).toBe("noargs");
    expect(json.options).toHaveLength(1);
    expect(json.options![0]).toMatchObject({
      name: "args",
      type: 3, // string
      required: false,
    });
  });

  it("emits options for each parsed param", () => {
    registry.register([
      cmdWithParams("p1", "find", [
        param("query", true, 0),
        param("path", false, 1),
      ]),
    ]);
    const json = registry.toDiscordCommands()[0]!.toJSON();
    expect(json.options).toHaveLength(2);
    expect(json.options![0]).toMatchObject({ name: "query", required: true });
    expect(json.options![1]).toMatchObject({ name: "path", required: false });
  });

  it("reorders required params before optional in Discord output", () => {
    registry.register([
      cmdWithParams("p1", "mixed", [
        param("optional_first", false, 0),
        param("required_second", true, 1),
      ]),
    ]);
    const json = registry.toDiscordCommands()[0]!.toJSON();
    expect(json.options!.map((o: any) => o.name)).toEqual([
      "required_second",
      "optional_first",
    ]);
  });

  it("uses the command description as the Discord description", () => {
    registry.register([
      {
        pluginName: "p1",
        commandName: "described",
        description: "A described command.",
        parsedParams: [],
        sourcePath: "/fake/x.md",
      },
    ]);
    const json = registry.toDiscordCommands()[0]!.toJSON();
    expect(json.description).toBe("A described command.");
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run:
```bash
npx vitest run src/plugins/registry.test.ts
```
Expected: new tests fail with "toDiscordCommands is not a function" or similar.

- [ ] **Step 3: Implement `toDiscordCommands`**

Add the following method to the `PluginRegistry` class in `src/plugins/registry.ts` (insert before the closing `}`):

```ts
  toDiscordCommands(): import("discord.js").SlashCommandBuilder[] {
    // Lazy require to keep this file usable in pure unit tests if needed.
    // discord.js exports SlashCommandBuilder as a runtime value.
    const { SlashCommandBuilder } = require("discord.js");

    return this.list().map((cmd) => {
      const builder = new SlashCommandBuilder()
        .setName(cmd.commandName)
        .setDescription(cmd.description);

      if (cmd.parsedParams.length === 0) {
        builder.addStringOption((opt: any) =>
          opt
            .setName("args")
            .setDescription("Free-form arguments")
            .setRequired(false),
        );
      } else {
        // Discord requires required options before optional. Sort by required
        // desc (true first), keeping originalIndex as tiebreaker for stability.
        const sorted = [...cmd.parsedParams].sort((a, b) => {
          if (a.required !== b.required) return a.required ? -1 : 1;
          return a.originalIndex - b.originalIndex;
        });
        for (const p of sorted) {
          builder.addStringOption((opt: any) =>
            opt
              .setName(p.name)
              .setDescription(p.description)
              .setRequired(p.required),
          );
        }
      }

      return builder;
    });
  }
```

Also at the top of `src/plugins/registry.ts`, add the import:

```ts
import { SlashCommandBuilder } from "discord.js";
```

And replace the lazy `require("discord.js")` line in `toDiscordCommands` with usage of the top-level import — the lazy form is there only because ESM-strict projects sometimes balk at runtime requires, but discord.js is already a peer dep in this project, so the top-level import is fine. Final method body:

```ts
  toDiscordCommands(): SlashCommandBuilder[] {
    return this.list().map((cmd) => {
      const builder = new SlashCommandBuilder()
        .setName(cmd.commandName)
        .setDescription(cmd.description);

      if (cmd.parsedParams.length === 0) {
        builder.addStringOption((opt) =>
          opt
            .setName("args")
            .setDescription("Free-form arguments")
            .setRequired(false),
        );
      } else {
        const sorted = [...cmd.parsedParams].sort((a, b) => {
          if (a.required !== b.required) return a.required ? -1 : 1;
          return a.originalIndex - b.originalIndex;
        });
        for (const p of sorted) {
          builder.addStringOption((opt) =>
            opt
              .setName(p.name)
              .setDescription(p.description)
              .setRequired(p.required),
          );
        }
      }

      return builder;
    });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
npx vitest run src/plugins/registry.test.ts
```
Expected: all 11 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/plugins/registry.ts src/plugins/registry.test.ts
git commit -m "registry: emit SlashCommandBuilder with required-first param ordering"
```

---

## Task 10: bridge — happy path + guards

**Files:**
- Create: `src/plugins/bridge.ts`
- Create: `src/plugins/bridge.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/plugins/bridge.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the database and session-manager modules BEFORE importing bridge.
const mockGetProject = vi.fn();
const mockIsActive = vi.fn();
const mockSendMessage = vi.fn();

vi.mock("../db/database.js", () => ({
  getProject: (channelId: string) => mockGetProject(channelId),
}));

vi.mock("../claude/session-manager.js", () => ({
  sessionManager: {
    isActive: (channelId: string) => mockIsActive(channelId),
    sendMessage: (channel: any, prompt: string) =>
      mockSendMessage(channel, prompt),
  },
}));

import { handlePluginCommand } from "./bridge.js";
import type { RegisteredPluginCommand } from "./types.js";

function makeInteraction(opts: {
  channelId?: string;
  options?: Record<string, string>;
  channel?: any;
}) {
  const optsMap = opts.options ?? {};
  return {
    channelId: opts.channelId ?? "chan-1",
    channel: opts.channel ?? { id: opts.channelId ?? "chan-1", send: vi.fn() },
    commandName: "autoresearch",
    options: {
      getString: (name: string) => optsMap[name] ?? null,
    },
    editReply: vi.fn().mockResolvedValue(undefined),
    deferred: true,
    replied: false,
  };
}

function reg(
  commandName: string,
  parsedParams: RegisteredPluginCommand["parsedParams"] = [],
): RegisteredPluginCommand {
  return {
    pluginName: "test-plugin",
    commandName,
    description: "x",
    parsedParams,
    sourcePath: "/fake",
    registeredAt: Date.now(),
  };
}

describe("handlePluginCommand", () => {
  beforeEach(() => {
    mockGetProject.mockReset();
    mockIsActive.mockReset();
    mockSendMessage.mockReset();
  });

  it("rejects with editReply when channel is not registered", async () => {
    mockGetProject.mockReturnValue(undefined);
    const interaction = makeInteraction({});

    await handlePluginCommand(interaction as any, reg("autoresearch"));

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringMatching(/not registered/i),
      }),
    );
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("rejects with editReply when a session is already active", async () => {
    mockGetProject.mockReturnValue({ project_path: "/p" });
    mockIsActive.mockReturnValue(true);
    const interaction = makeInteraction({});

    await handlePluginCommand(interaction as any, reg("autoresearch"));

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringMatching(/in progress|busy|active/i),
      }),
    );
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("builds '/autoresearch' prompt when no args and dispatches to sessionManager", async () => {
    mockGetProject.mockReturnValue({ project_path: "/p" });
    mockIsActive.mockReturnValue(false);
    const channel = { id: "chan-1", send: vi.fn() };
    const interaction = makeInteraction({ channel });

    await handlePluginCommand(interaction as any, reg("autoresearch"));

    expect(mockSendMessage).toHaveBeenCalledWith(channel, "/autoresearch");
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("/autoresearch"),
      }),
    );
  });

  it("includes single `args` value in the prompt for paramless commands", async () => {
    mockGetProject.mockReturnValue({ project_path: "/p" });
    mockIsActive.mockReturnValue(false);
    const interaction = makeInteraction({
      options: { args: "AI agents in 2026" },
    });

    await handlePluginCommand(interaction as any, reg("autoresearch"));

    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.anything(),
      "/autoresearch AI agents in 2026",
    );
  });

  it("reconstructs prompt in originalIndex order, not Discord's required-first order", async () => {
    mockGetProject.mockReturnValue({ project_path: "/p" });
    mockIsActive.mockReturnValue(false);
    const interaction = makeInteraction({
      options: { range: "10-20", file: "foo.md" },
    });

    const command = reg("excerpt", [
      // originalIndex 0 = file (required), originalIndex 1 = range (optional).
      // Discord UI showed file first because it's required, but the prompt
      // must still come out in declaration order: file then range.
      { name: "file", description: "file", required: true, originalIndex: 0 },
      { name: "range", description: "range", required: false, originalIndex: 1 },
    ]);

    await handlePluginCommand(interaction as any, command);

    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.anything(),
      "/excerpt foo.md 10-20",
    );
  });

  it("drops empty trailing param values from the prompt", async () => {
    mockGetProject.mockReturnValue({ project_path: "/p" });
    mockIsActive.mockReturnValue(false);
    const interaction = makeInteraction({
      options: { file: "foo.md" }, // range omitted
    });

    const command = reg("excerpt", [
      { name: "file", description: "file", required: true, originalIndex: 0 },
      { name: "range", description: "range", required: false, originalIndex: 1 },
    ]);

    await handlePluginCommand(interaction as any, command);

    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.anything(),
      "/excerpt foo.md",
    );
  });
});
```

- [ ] **Step 2: Write the bridge implementation**

Create `src/plugins/bridge.ts`:

```ts
import type { ChatInputCommandInteraction, TextChannel } from "discord.js";
import { getProject } from "../db/database.js";
import { sessionManager } from "../claude/session-manager.js";
import { L } from "../utils/i18n.js";
import type { RegisteredPluginCommand } from "./types.js";

/**
 * Discord slash command handler for any plugin-derived command.
 *
 * client.ts has already called interaction.deferReply() before dispatch, so
 * any user-facing response from this function goes through editReply / followUp.
 *
 * On success, this function acknowledges the slash invocation via editReply
 * and hands the actual prompt off to sessionManager.sendMessage(), which
 * creates its own channel.send() messages for the streaming response —
 * identical to how freeform user messages are processed today.
 */
export async function handlePluginCommand(
  interaction: ChatInputCommandInteraction,
  registered: RegisteredPluginCommand,
): Promise<void> {
  const channelId = interaction.channelId;

  // Guard: channel must be registered to a project
  if (!getProject(channelId)) {
    await interaction.editReply({
      content: L(
        "This channel is not registered to a project. Run `/register` first.",
        "이 채널은 프로젝트에 등록되지 않았습니다. 먼저 `/register`를 사용하세요.",
      ),
    });
    return;
  }

  // Guard: refuse if a session is already active
  if (sessionManager.isActive(channelId)) {
    await interaction.editReply({
      content: L(
        "A task is already in progress in this channel. Wait for it to finish or use `/stop`.",
        "이 채널에서 이미 작업이 진행 중입니다. 완료될 때까지 기다리거나 `/stop`을 사용하세요.",
      ),
    });
    return;
  }

  // Reconstruct prompt in originalIndex order (not Discord's required-first order)
  const prompt = buildPrompt(interaction, registered);

  await interaction.editReply({
    content: L(`Running \`${prompt}\``, `실행 중: \`${prompt}\``),
  });

  // Hand off to the existing session pipeline. The channel object on the
  // interaction is the same TextChannel the message handler uses.
  const channel = interaction.channel as TextChannel;
  await sessionManager.sendMessage(channel, prompt);
}

function buildPrompt(
  interaction: ChatInputCommandInteraction,
  registered: RegisteredPluginCommand,
): string {
  const name = registered.commandName;

  if (registered.parsedParams.length === 0) {
    const args = (interaction.options.getString("args") ?? "").trim();
    return args ? `/${name} ${args}` : `/${name}`;
  }

  // Read each param's value in originalIndex order, drop empty trailing values.
  const sorted = [...registered.parsedParams].sort(
    (a, b) => a.originalIndex - b.originalIndex,
  );
  const values: string[] = [];
  for (const p of sorted) {
    const v = (interaction.options.getString(p.name) ?? "").trim();
    values.push(v);
  }
  while (values.length > 0 && values[values.length - 1] === "") {
    values.pop();
  }
  const joined = values.join(" ");
  return joined ? `/${name} ${joined}` : `/${name}`;
}
```

- [ ] **Step 3: Run tests to verify they pass**

Run:
```bash
npx vitest run src/plugins/bridge.test.ts
```
Expected: all 6 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/plugins/bridge.ts src/plugins/bridge.test.ts
git commit -m "bridge: dispatch plugin slash commands to sessionManager.sendMessage"
```

---

## Task 11: Dev script for inspecting discovered commands

**Files:**
- Create: `scripts/list-plugin-commands.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the script**

Create `scripts/list-plugin-commands.ts`:

```ts
import { scanInstalledPlugins } from "../src/plugins/discovery.js";

const result = await scanInstalledPlugins();

console.log(`Discovered ${result.commands.length} command(s).`);
if (result.warnings.length > 0) {
  console.log(`\nWarnings:`);
  for (const w of result.warnings) console.log(`  - ${w}`);
}

if (result.commands.length === 0) {
  process.exit(0);
}

console.log(`\nCommands:`);
for (const c of result.commands) {
  console.log(`  /${c.commandName}  ←  ${c.pluginName}`);
  console.log(`    description: ${c.description}`);
  if (c.parsedParams.length === 0) {
    console.log(`    params: (none — fallback to single 'args')`);
  } else {
    for (const p of c.parsedParams) {
      const marker = p.required ? "<required>" : "[optional]";
      console.log(`    param: ${p.name} ${marker}  — ${p.description}`);
    }
  }
}
```

- [ ] **Step 2: Add npm script**

Modify `package.json` — add the script to the `scripts` block:

```json
{
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsup src/index.ts --format esm --dts",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "scripts:list-plugin-commands": "tsx scripts/list-plugin-commands.ts"
  }
}
```

- [ ] **Step 3: Run the script against the user's actual install**

Run:
```bash
npm run scripts:list-plugin-commands
```
Expected: lists the 4 claude-obsidian commands (autoresearch, canvas, save, wiki), each marked as "fallback to single 'args'" since none currently have `argument-hint`. Discord names are valid. No warnings.

If anything looks wrong (missing plugins, weird parsed params), pause and investigate before continuing.

- [ ] **Step 4: Commit**

```bash
git add scripts/list-plugin-commands.ts package.json
git commit -m "Add dev script to inspect discovered plugin commands"
```

---

## Task 12: Wire discovery into bot startup

**Files:**
- Modify: `src/bot/client.ts`

- [ ] **Step 1: Read the current state of client.ts**

Confirm: `src/bot/client.ts` lines 16-37 import 11 bot-owned commands and build `commandMap`. Lines 51-67 register slash commands via REST. The structure to follow: extend `commandMap` and the `commandData` array before the REST call.

- [ ] **Step 2: Add imports and registry instance**

In `src/bot/client.ts`, after the existing command imports (line ~27), add:

```ts
import { scanInstalledPlugins } from "../plugins/discovery.js";
import { PluginRegistry } from "../plugins/registry.js";
import { handlePluginCommand } from "../plugins/bridge.js";
import type { RegisteredPluginCommand } from "../plugins/types.js";

// Exported so /plugins-sync and /plugins-list can access it
export const pluginRegistry = new PluginRegistry(
  new Set(commands.map((c) => c.data.name)),
);
```

- [ ] **Step 3: Run discovery before REST registration**

In `src/bot/client.ts`, modify the `client.on("ready", ...)` callback to run discovery first and merge plugin commands into the REST registration body.

Replace lines ~51-67 (the entire `client.on("ready", ...)` block) with:

```ts
  client.on("ready", async () => {
    console.log(`Bot logged in as ${client.user?.tag}`);

    // Discover and register plugin commands before pushing slash commands to Discord
    try {
      const discovery = await scanInstalledPlugins();
      for (const w of discovery.warnings) console.warn(`[plugins] ${w}`);

      const result = pluginRegistry.register(discovery.commands);
      console.log(
        `[plugins] Registered ${result.registered.length} plugin command(s); skipped ${result.skipped.length}`,
      );
      for (const s of result.skipped) {
        console.warn(`[plugins] skipped /${s.commandName} from ${s.pluginName}: ${s.reason}`);
      }

      // Add each registered plugin command to commandMap with a thunk
      for (const reg of result.registered) {
        commandMap.set(reg.commandName, {
          execute: (interaction) => handlePluginCommand(interaction, reg),
        });
      }
    } catch (e) {
      console.error("[plugins] Discovery failed:", e);
    }

    try {
      const rest = new REST({ version: "10" }).setToken(config.DISCORD_BOT_TOKEN);
      const botOwnedData = commands.map((c) => c.data.toJSON());
      const pluginData = pluginRegistry.toDiscordCommands().map((b) => b.toJSON());
      const commandData = [...botOwnedData, ...pluginData];

      await rest.put(
        Routes.applicationGuildCommands(
          (await rest.get(Routes.currentApplication()) as { id: string }).id,
          config.DISCORD_GUILD_ID,
        ),
        { body: commandData },
      );
      console.log(
        `Registered ${commandData.length} slash commands (${botOwnedData.length} bot-owned, ${pluginData.length} plugin-derived)`,
      );
    } catch (error) {
      console.error("Failed to register slash commands:", error);
    }
  });
```

- [ ] **Step 4: Verify TypeScript compiles**

Run:
```bash
npx tsc --noEmit
```
Expected: no errors. Common gotcha: the `execute` thunk's `interaction` parameter type — TypeScript may need an explicit annotation. If you get a type error there, change the thunk to:

```ts
execute: (interaction: ChatInputCommandInteraction) => handlePluginCommand(interaction, reg),
```

`ChatInputCommandInteraction` is already imported at the top of `client.ts`.

- [ ] **Step 5: Smoke test the bot startup**

Run:
```bash
npm run dev
```

Wait for the bot to log "Bot logged in as …". Expected console output:
- `[plugins] Registered 4 plugin command(s); skipped 0`
- `Registered 15 slash commands (11 bot-owned, 4 plugin-derived)` (counts may differ slightly if you've added more bot commands)

Then in Discord, type `/` in a registered channel. You should see `autoresearch`, `canvas`, `save`, `wiki` in the autocomplete list alongside the existing bot commands.

Stop the bot with Ctrl-C.

- [ ] **Step 6: Commit**

```bash
git add src/bot/client.ts
git commit -m "client: discover plugin commands at startup and register with Discord"
```

---

## Task 13: /plugins-sync bot command

**Files:**
- Create: `src/bot/commands/plugins-sync.ts`
- Modify: `src/bot/client.ts`

- [ ] **Step 1: Write the command**

Create `src/bot/commands/plugins-sync.ts`:

```ts
import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  REST,
  Routes,
  PermissionFlagsBits,
} from "discord.js";
import { scanInstalledPlugins } from "../../plugins/discovery.js";
import {
  pluginRegistry,
  commandMap,
  botOwnedCommandNames,
} from "../client.js";
import { handlePluginCommand } from "../../plugins/bridge.js";
import { getConfig } from "../../utils/config.js";
import { L } from "../../utils/i18n.js";

export const data = new SlashCommandBuilder()
  .setName("plugins-sync")
  .setDescription("Re-scan installed Claude plugins and refresh Discord slash commands")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const config = getConfig();

  const discovery = await scanInstalledPlugins();
  pluginRegistry.clear();
  const result = pluginRegistry.register(discovery.commands);

  // Live-update the in-memory commandMap so newly-arriving slash interactions
  // dispatch to the refreshed plugin thunks. The static imports above resolve
  // fine at call time even though there's a structural circular dep with
  // client.ts: by the time execute() runs, both modules are fully evaluated.
  for (const name of [...commandMap.keys()]) {
    if (!botOwnedCommandNames.has(name)) commandMap.delete(name);
  }
  for (const reg of result.registered) {
    commandMap.set(reg.commandName, {
      execute: (i: ChatInputCommandInteraction) => handlePluginCommand(i, reg),
    });
  }

  // Push the new full set to Discord
  try {
    const rest = new REST({ version: "10" }).setToken(config.DISCORD_BOT_TOKEN);
    const botOwnedData = Array.from(commandMap.values())
      .filter((c: any) => "data" in c)
      .map((c: any) => c.data.toJSON());
    const pluginData = pluginRegistry.toDiscordCommands().map((b) => b.toJSON());
    const commandData = [...botOwnedData, ...pluginData];
    await rest.put(
      Routes.applicationGuildCommands(
        (await rest.get(Routes.currentApplication()) as { id: string }).id,
        config.DISCORD_GUILD_ID,
      ),
      { body: commandData },
    );
  } catch (e) {
    await interaction.editReply({
      content: L(
        `Discovery succeeded but Discord registration failed: ${(e as Error).message}`,
        `발견은 성공했지만 Discord 등록이 실패했습니다: ${(e as Error).message}`,
      ),
    });
    return;
  }

  const lines = [
    L(
      `Re-scanned plugins: ${result.registered.length} command(s) registered, ${result.skipped.length} skipped.`,
      `플러그인 재검색: ${result.registered.length}개 명령 등록, ${result.skipped.length}개 건너뜀.`,
    ),
  ];
  if (discovery.warnings.length > 0) {
    lines.push("");
    lines.push(L("Warnings:", "경고:"));
    for (const w of discovery.warnings) lines.push(`  • ${w}`);
  }
  lines.push("");
  lines.push(L(
    "Note: Discord client may take up to 1 minute to refresh the autocomplete menu.",
    "참고: Discord 클라이언트가 자동 완성 메뉴를 새로 고치는 데 최대 1분이 걸릴 수 있습니다.",
  ));

  await interaction.editReply({ content: lines.join("\n") });
}
```

- [ ] **Step 2: Update client.ts to export commandMap and botOwnedCommandNames, add plugins-sync to commands**

In `src/bot/client.ts`, find the existing block (around line 29-37):

```ts
const commands = [registerCmd, unregisterCmd, worktreeCmd, statusCmd, stopCmd, autoApproveCmd, sessionsCmd, clearSessionsCmd, lastCmd, queueCmd, usageCmd];
const commandMap = new Collection<
  string,
  { execute: (interaction: ChatInputCommandInteraction) => Promise<void> }
>();

for (const cmd of commands) {
  commandMap.set(cmd.data.name, cmd);
}
```

Replace with:

```ts
import * as pluginsSyncCmd from "./commands/plugins-sync.js";

const commands = [
  registerCmd, unregisterCmd, worktreeCmd, statusCmd, stopCmd, autoApproveCmd,
  sessionsCmd, clearSessionsCmd, lastCmd, queueCmd, usageCmd,
  pluginsSyncCmd,
];
export const botOwnedCommandNames = new Set(commands.map((c) => c.data.name));
export const commandMap = new Collection<
  string,
  { execute: (interaction: ChatInputCommandInteraction) => Promise<void>; data?: any }
>();

for (const cmd of commands) {
  commandMap.set(cmd.data.name, cmd);
}
```

(Task 14 will add `pluginsListCmd` to this same array. We're adding `pluginsSyncCmd` here so plugins-sync.ts's static imports of `commandMap` / `botOwnedCommandNames` resolve cleanly.)

Also update the `pluginRegistry` line — it should use `botOwnedCommandNames` (now exported) instead of computing the set inline:

```ts
export const pluginRegistry = new PluginRegistry(botOwnedCommandNames);
```

- [ ] **Step 3: Verify TypeScript compiles**

Run:
```bash
npx tsc --noEmit
```
Expected: no errors. If errors point at the circular `pluginRegistry` import inside `plugins-sync.ts`, that's a real problem — let me know.

- [ ] **Step 4: Smoke test**

Run:
```bash
npm run dev
```

Expected console output now includes a 12th bot-owned command (`plugins-sync`). In Discord, `/plugins-sync` should appear in the slash autocomplete (the execute function works but doesn't have anything specifically to show until you have plugin commands; it will reply with the summary message). Stop with Ctrl-C.

- [ ] **Step 5: Commit**

```bash
git add src/bot/commands/plugins-sync.ts src/bot/client.ts
git commit -m "Add /plugins-sync command for manual plugin refresh"
```

---

## Task 14: /plugins-list bot command

**Files:**
- Create: `src/bot/commands/plugins-list.ts`

- [ ] **Step 1: Write the command**

Create `src/bot/commands/plugins-list.ts`:

```ts
import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
} from "discord.js";
import { pluginRegistry } from "../client.js";
import { L } from "../../utils/i18n.js";

export const data = new SlashCommandBuilder()
  .setName("plugins-list")
  .setDescription("List currently-registered plugin slash commands")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const registered = pluginRegistry.list();
  const skipped = pluginRegistry.skippedList();

  if (registered.length === 0 && skipped.length === 0) {
    await interaction.editReply({
      content: L(
        "No plugin commands discovered. Run `/plugins-sync` to refresh, or check that ~/.claude/plugins/installed_plugins.json lists your plugins.",
        "발견된 플러그인 명령이 없습니다. `/plugins-sync`로 새로 고치거나 ~/.claude/plugins/installed_plugins.json을 확인하세요.",
      ),
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(L("Plugin Commands", "플러그인 명령"))
    .setColor(0x7c3aed)
    .setTimestamp();

  if (registered.length > 0) {
    const lines = registered.map((c) => {
      const paramInfo = c.parsedParams.length === 0
        ? "(args)"
        : c.parsedParams
            .map((p) => (p.required ? `<${p.name}>` : `[${p.name}]`))
            .join(" ");
      return `\`/${c.commandName} ${paramInfo}\` — ${c.pluginName}`;
    });
    embed.addFields({
      name: L(`Registered (${registered.length})`, `등록됨 (${registered.length})`),
      value: lines.join("\n").slice(0, 1024),
    });
  }

  if (skipped.length > 0) {
    const lines = skipped.map(
      (s) => `\`/${s.commandName}\` (${s.pluginName}): ${s.reason}`,
    );
    embed.addFields({
      name: L(`Skipped (${skipped.length})`, `건너뜀 (${skipped.length})`),
      value: lines.join("\n").slice(0, 1024),
    });
  }

  await interaction.editReply({ embeds: [embed] });
}
```

- [ ] **Step 2: Register plugins-list in client.ts**

In `src/bot/client.ts`, find the line:
```ts
import * as pluginsSyncCmd from "./commands/plugins-sync.js";
```

Add right after it:
```ts
import * as pluginsListCmd from "./commands/plugins-list.js";
```

In the `commands` array, add `pluginsListCmd`:
```ts
const commands = [
  registerCmd, unregisterCmd, worktreeCmd, statusCmd, stopCmd, autoApproveCmd,
  sessionsCmd, clearSessionsCmd, lastCmd, queueCmd, usageCmd,
  pluginsSyncCmd, pluginsListCmd,
];
```

- [ ] **Step 3: Verify TypeScript compiles**

Run:
```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 4: Run the full test suite**

Run:
```bash
npm test
```
Expected: all tests pass (existing + the 4 new test files: argument-hint, discovery, registry, bridge). No regressions in existing tests.

- [ ] **Step 5: Smoke test the bot**

Run:
```bash
npm run dev
```

Expected console output:
- `[plugins] Registered 4 plugin command(s); skipped 0`
- `Registered 17 slash commands (13 bot-owned, 4 plugin-derived)` (11 original + plugins-sync + plugins-list + 4 plugin)

In Discord:
1. Type `/plugins-list` — should see an embed with 4 registered claude-obsidian commands, each shown as `/<name> (args)` (because no argument-hint exists yet).
2. Type `/plugins-sync` — should reply with "Re-scanned plugins: 4 command(s) registered, 0 skipped."
3. Type `/autoresearch` — Discord should show `args` as an optional string parameter.

Stop the bot with Ctrl-C.

- [ ] **Step 6: Commit**

```bash
git add src/bot/commands/plugins-list.ts src/bot/client.ts
git commit -m "Add /plugins-list command showing registered and skipped plugin commands"
```

---

## Task 15: End-to-end manual verification (Phase 4)

This task has no code — it's a checklist confirming the feature works end-to-end. Do all of these in Discord against a real bot session.

- [ ] **Step 1: Set up the test channel**

In Discord, in a channel registered to a project that is NOT the claude-obsidian vault:
- Type `/autoresearch` — should respond with "This channel is not registered to a project" OR forward to Claude and let Claude respond appropriately. Either is acceptable per spec.

Then `/register` a channel to `/Users/leric/Desktop/code/claude-obsidian` (the vault). Continue tests in that channel.

- [ ] **Step 2: Fallback parameter path (no argument-hint)**

In the vault channel:
- Type `/autoresearch args:"AI agents in 2026"`
- Confirm:
  - Bot's interaction reply shows `Running /autoresearch AI agents in 2026`.
  - A channel message starts streaming the autoresearch session.
  - The autoresearch skill actually fires (you should see tool calls, wiki writes, eventually a summary).

- [ ] **Step 3: Empty-args case**

- Type `/wiki` with no args.
- Confirm: bot replies `Running /wiki`, then wiki skill runs (status check or scaffold prompt).

- [ ] **Step 4: Concurrent-session guard**

- Trigger a long autoresearch task: `/autoresearch args:"some long topic"`.
- While it's still running, type `/save` in the same channel.
- Confirm: bot replies "A task is already in progress…"; the running autoresearch is unaffected.

- [ ] **Step 5: Typed parameters via argument-hint (temporary test)**

- Open `/Users/leric/.claude/plugins/cache/claude-obsidian-marketplace/claude-obsidian/1.6.0/commands/autoresearch.md`.
- Add `argument-hint: "[topic]"` to the frontmatter (just below `description:`). Save.
- In Discord, run `/plugins-sync`. Wait up to 1 minute (Discord client cache).
- Type `/` — `autoresearch` should now show a `topic` parameter (instead of `args`).
- Run `/autoresearch topic:"AI agents"` — should run identically to Step 2.
- Revert the frontmatter change (remove the `argument-hint:` line), run `/plugins-sync` again.

- [ ] **Step 6: Mixed required + optional + ordering (synthetic test)**

- Create a fake command for testing: write `/Users/leric/.claude/plugins/cache/claude-obsidian-marketplace/claude-obsidian/1.6.0/commands/_test.md`:

  ```
  ---
  description: Test command for parameter ordering verification.
  argument-hint: "<query> [path]"
  ---
  echo back: $ARGS
  ```

  (Filename starting with `_` is intentional — `_test` is still a valid Discord name `[a-z0-9_-]`.)
- Run `/plugins-sync`.
- Type `/` — `_test` should appear with `query` (required) first, `path` (optional) second.
- Run `/_test query:"hello" path:"/tmp"`.
- Confirm: bot replies `Running /_test hello /tmp` (query value before path value).
- Run `/_test query:"hello"` (omit path).
- Confirm: bot replies `Running /_test hello` (no trailing space, optional dropped).
- Delete `_test.md`, run `/plugins-sync`.

- [ ] **Step 7: Run all tests one more time**

Run:
```bash
npm test
```
Expected: all tests pass.

- [ ] **Step 8: Final commit (only if any fixes were made during E2E)**

If you discovered and fixed any issues during this verification:
```bash
git add -A
git commit -m "E2E fixes from Phase 4 verification"
```

If no fixes were needed, nothing to commit.

---

## Implementation Done

All 15 tasks complete. The feature is shipped:
- Plugin commands auto-discovered from `~/.claude/plugins/installed_plugins.json`.
- Each `commands/*.md` registers as a native Discord slash command.
- `argument-hint:` parsed into typed Discord parameters when present; single `args` fallback otherwise.
- `/plugins-sync` and `/plugins-list` provide manual refresh and visibility.
- Existing freeform-message handling, tool approval, session resume, all 12 bot-owned commands: untouched.
- DB schema: untouched.
- `.env`: untouched.

After landing, optionally update the upstream `claude-obsidian` repo to add `argument-hint:` frontmatter to its 4 commands so users get named parameters out of the box.
