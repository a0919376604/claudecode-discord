# Plugin Command Path Autocomplete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plugin-derived Discord slash commands whose argument represents a repo/path get a `BASE_PROJECT_DIR` autocomplete dropdown (just like `/register`), with the channel's registered project pinned at the top.

**Architecture:** Detect path-typed params in `argument-hint` via a name-convention list (`repo / repo-path / path / project / project-path / dir / directory`) plus an optional `<name:type>` annotation. Refactor the existing `/register` and `/worktree` autocomplete walk into a single shared helper (`src/utils/project-dirs.ts`). Registry sets `setAutocomplete(true)` on path-typed options; bridge serves the autocomplete callback and resolves picked values to absolute paths before dispatching to Claude.

**Tech Stack:** TypeScript (ESM, strict), discord.js v14, vitest, node.js `fs` / `path`.

**Spec:** `docs/superpowers/specs/2026-05-26-plugin-path-autocomplete-design.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/plugins/types.ts` | Modify | Add `type: "path" \| "text"` to `ParsedParam`. |
| `src/plugins/argument-hint.ts` | Modify | Extend `SLOT_RE` with optional `:type` capture; apply `PATH_PARAM_NAMES` convention; emit `type` on each `ParsedParam`. |
| `src/plugins/argument-hint.test.ts` | Modify | Add `type` to existing assertions; cover convention names, explicit `:path` / `:text`, unknown `:type` fallback. |
| `src/utils/project-dirs.ts` | Create | `listProjectSubdirs`, `resolveProjectPath`, `PathValidationError`. |
| `src/utils/project-dirs.test.ts` | Create | Unit tests for the helper (nested walk, filter, `includeBaseDirSelf`, `includeCreateNew`, ⭐ dedup). |
| `src/plugins/registry.ts` | Modify | `toDiscordCommands()` calls `.setAutocomplete(true)` when `p.type === "path"`. |
| `src/plugins/registry.test.ts` | Modify | Existing `param()` helper gains `type`; new test asserts autocomplete flag based on `type`. |
| `src/plugins/bridge.ts` | Modify | New exported `handlePluginAutocomplete`; `buildPrompt` resolves path-typed values and throws `PathValidationError`; `handlePluginCommand` catches and replies ephemerally. |
| `src/plugins/bridge.test.ts` | Modify | Add `type` to fixtures; tests for autocomplete handler; tests for path resolution + `..` rejection + escape rejection. |
| `src/plugins/discovery.test.ts` | Modify | Add `type` to assertion fixtures (fallout from interface change). |
| `src/bot/commands/register.ts` | Modify | Replace inline `autocomplete()` body with `listProjectSubdirs({ includeBaseDirSelf: true, includeCreateNew: true })`. |
| `src/bot/commands/worktree.ts` | Modify | Replace inline `autocomplete()` body with `listProjectSubdirs({ includeBaseDirSelf: false, includeCreateNew: false })`. |
| `src/bot/client.ts` | Modify | Autocomplete dispatch falls through to `handlePluginAutocomplete` when the name isn't bot-owned. |

---

## Task 1: Extend `ParsedParam` with `type` field + name convention + `:type` override

**Files:**
- Modify: `src/plugins/types.ts:14-19`
- Modify: `src/plugins/argument-hint.ts:1-68`
- Modify: `src/plugins/argument-hint.test.ts` (all existing assertions; add new cases)
- Modify: `src/plugins/registry.test.ts:96-103` (`param()` helper)
- Modify: `src/plugins/bridge.test.ts:174-175,194-195`
- Modify: `src/plugins/discovery.test.ts:148-149`

- [ ] **Step 1: Add `type` field to `ParsedParam` interface**

Edit `src/plugins/types.ts`. Change lines 14–19 from:

```typescript
export interface ParsedParam {
  name: string; // sanitized: ^[a-z0-9_-]{1,32}$
  description: string; // <= 100 chars, defaults to name if hint had none
  required: boolean;
  originalIndex: number; // 0-based position in the source hint
}
```

To:

```typescript
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
```

- [ ] **Step 2: Write failing tests for name convention + `:type` override**

Edit `src/plugins/argument-hint.test.ts`. **First**, append `type: "text"` to every existing assertion in the file — `toEqual([{ name: ..., description: ..., required: ..., originalIndex: ... }])` must become `toEqual([{ name: ..., description: ..., required: ..., originalIndex: ..., type: "text" }])` for every test that currently passes. There are roughly 12 such assertions; touch each.

For the duplicate-suffix test (lines 75–80), all three entries get `type: "text"`.

For the truncation test (lines 83–89), no change — it only asserts on `description` length.

For the mixed-slots test at lines 59–65, all three entries get `type: "text"`.

**Then** add this new describe block at the end of the file:

```typescript
describe("parseArgumentHint — type inference", () => {
  it("infers type='path' for the 'repo' name", () => {
    expect(parseArgumentHint("<repo>")).toEqual([
      { name: "repo", description: "repo", required: true, originalIndex: 0, type: "path" },
    ]);
  });

  it("infers type='path' for 'repo-path'", () => {
    expect(parseArgumentHint("<repo-path>")).toEqual([
      { name: "repo-path", description: "repo-path", required: true, originalIndex: 0, type: "path" },
    ]);
  });

  it("infers type='path' for all of: path, project, project-path, dir, directory", () => {
    for (const n of ["path", "project", "project-path", "dir", "directory"]) {
      const result = parseArgumentHint(`<${n}>`);
      expect(result).toHaveLength(1);
      expect(result[0]!.type).toBe("path");
    }
  });

  it("infers type='text' for non-convention names", () => {
    expect(parseArgumentHint("<topic>")).toEqual([
      { name: "topic", description: "topic", required: true, originalIndex: 0, type: "text" },
    ]);
  });

  it("name convention is case-insensitive via existing lowercase sanitization", () => {
    expect(parseArgumentHint("<Repo>")).toEqual([
      { name: "repo", description: "repo", required: true, originalIndex: 0, type: "path" },
    ]);
  });

  it("explicit <name:path> forces type='path' on a non-convention name", () => {
    expect(parseArgumentHint("<topic:path>")).toEqual([
      { name: "topic", description: "topic", required: true, originalIndex: 0, type: "path" },
    ]);
  });

  it("explicit <name:text> forces type='text' on a convention name", () => {
    expect(parseArgumentHint("<path:text>")).toEqual([
      { name: "path", description: "path", required: true, originalIndex: 0, type: "text" },
    ]);
  });

  it("unknown :type token falls back to name convention", () => {
    expect(parseArgumentHint("<repo:nope>")).toEqual([
      { name: "repo", description: "repo", required: true, originalIndex: 0, type: "path" },
    ]);
    expect(parseArgumentHint("<topic:nope>")).toEqual([
      { name: "topic", description: "topic", required: true, originalIndex: 0, type: "text" },
    ]);
  });

  it("preserves inline description alongside :type annotation", () => {
    expect(parseArgumentHint("<topic:path the repo to scan>")).toEqual([
      { name: "topic", description: "the repo to scan", required: true, originalIndex: 0, type: "path" },
    ]);
  });

  it("supports type annotation on optional slots", () => {
    expect(parseArgumentHint("[topic:path]")).toEqual([
      { name: "topic", description: "topic", required: false, originalIndex: 0, type: "path" },
    ]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/plugins/argument-hint.test.ts`
Expected: FAIL — both pre-existing tests (now expect `type: "text"` which the parser doesn't emit) and the new type-inference tests (parser doesn't know `:type` syntax).

- [ ] **Step 4: Implement the parser changes**

Edit `src/plugins/argument-hint.ts`. Replace lines 17–68 (the entire body below the imports/comment) with:

```typescript
// Matches a single slot: [name] or <name> with optional :type annotation
// and optional inline description. The :type token is a separate capture so
// we can interpret it without breaking the existing name char class.
// The description body excludes all bracket characters so an unclosed
// opener (e.g. "[topic <unclosed [file]") doesn't swallow a later valid slot.
const SLOT_RE =
  /([<\[])\s*([A-Za-z][A-Za-z0-9_-]*)(?:\s*:\s*([A-Za-z][A-Za-z0-9_-]*))?(?:\s+([^<>\[\]]*))?\s*([>\]])/g;

const MAX_PARAMS = 25;
const MAX_DESC_LEN = 100;

/**
 * Param names whose presence in `argument-hint` causes the bridge to attach
 * a BASE_PROJECT_DIR autocomplete dropdown in Discord. Case-insensitive
 * (matched against the already-lowercased baseName).
 *
 * Plugin authors can override on a per-slot basis with explicit `<name:type>`
 * syntax — e.g. `<topic:path>` forces path on a non-convention name, and
 * `<path:text>` opts a convention name out.
 */
const PATH_PARAM_NAMES = new Set([
  "repo",
  "repo-path",
  "path",
  "project",
  "project-path",
  "dir",
  "directory",
]);

function truncateDescription(desc: string): string {
  if (desc.length <= MAX_DESC_LEN) return desc;
  return desc.slice(0, MAX_DESC_LEN - 3) + "...";
}

export function parseArgumentHint(hint: string): ParsedParam[] {
  if (!hint || !hint.trim()) return [];

  const params: ParsedParam[] = [];
  const seenNames = new Map<string, number>();
  let match: RegExpExecArray | null;
  let index = 0;

  SLOT_RE.lastIndex = 0;
  while ((match = SLOT_RE.exec(hint)) !== null) {
    if (params.length >= MAX_PARAMS) break;

    const [, openBracket, rawName, rawTypeToken, rawDesc = "", closeBracket] = match;
    // Bracket pair must match (no mixing < with ])
    const isRequired = openBracket === "<" && closeBracket === ">";
    const isOptional = openBracket === "[" && closeBracket === "]";
    if (!isRequired && !isOptional) continue;

    const baseName = rawName.toLowerCase();
    const seen = seenNames.get(baseName) ?? 0;
    seenNames.set(baseName, seen + 1);
    const name = seen === 0 ? baseName : `${baseName}_${seen + 1}`;

    const description = truncateDescription(rawDesc.trim() || baseName);

    // Type resolution: explicit :type wins when it's a known token;
    // otherwise fall back to name convention; otherwise "text".
    let type: "path" | "text";
    if (rawTypeToken === "path" || rawTypeToken === "text") {
      type = rawTypeToken;
    } else if (PATH_PARAM_NAMES.has(baseName)) {
      type = "path";
    } else {
      type = "text";
    }

    params.push({
      name,
      description,
      required: isRequired,
      originalIndex: index,
      type,
    });
    index++;
  }

  return params;
}
```

- [ ] **Step 5: Run argument-hint tests — expect PASS**

Run: `npx vitest run src/plugins/argument-hint.test.ts`
Expected: PASS — all original tests (now updated to expect `type: "text"`) and all new type-inference tests.

- [ ] **Step 6: Fix downstream test fixtures**

Add `type: "text"` to the `ParsedParam` literal in `src/plugins/registry.test.ts` line 102:

```typescript
function param(
  name: string,
  required: boolean,
  originalIndex: number,
  description = name,
): ParsedParam {
  return { name, description, required, originalIndex, type: "text" };
}
```

Add `type: "text"` to the inline `ParsedParam` literals in `src/plugins/bridge.test.ts`. Find lines 174–175:

```typescript
{ name: "file", description: "file", required: true, originalIndex: 0 },
{ name: "range", description: "range", required: false, originalIndex: 1 },
```

Change to:

```typescript
{ name: "file", description: "file", required: true, originalIndex: 0, type: "text" },
{ name: "range", description: "range", required: false, originalIndex: 1, type: "text" },
```

Apply the same change at lines 194–195 (the same two-line pair appears twice).

Add `type: "text"` to the inline assertions in `src/plugins/discovery.test.ts` lines 148–149:

```typescript
{ name: "query", description: "query", required: true, originalIndex: 0 },
{ name: "path", description: "path", required: false, originalIndex: 1 },
```

The `path` one should become `type: "path"` (it's the convention!), and `query` is `type: "text"`:

```typescript
{ name: "query", description: "query", required: true, originalIndex: 0, type: "text" },
{ name: "path", description: "path", required: false, originalIndex: 1, type: "path" },
```

> NOTE: This last edit changes a test expectation about discovery output. Verify the test still passes — discovery.ts pipes through `parseArgumentHint`, which will now correctly emit `type: "path"` for the param named `path`. If it doesn't, the discovery test was a regression in disguise.

- [ ] **Step 7: Run the full test suite — expect PASS**

Run: `npx vitest run`
Expected: PASS for `argument-hint`, `registry`, `bridge`, `discovery`. Any other failures (e.g. an unrelated module reading `ParsedParam` without `type`) indicate a missed fixture — fix the same way.

- [ ] **Step 8: Run the TypeScript compiler — expect clean**

Run: `npx tsc --noEmit`
Expected: no errors. If a TS error mentions `type` missing on `ParsedParam`, locate the file and add it.

- [ ] **Step 9: Commit**

```bash
git add src/plugins/types.ts src/plugins/argument-hint.ts src/plugins/argument-hint.test.ts src/plugins/registry.test.ts src/plugins/bridge.test.ts src/plugins/discovery.test.ts
git commit -m "argument-hint: type-tag params via convention + <name:type> annotation"
```

---

## Task 2: Create `src/utils/project-dirs.ts` shared helper

**Files:**
- Create: `src/utils/project-dirs.ts`
- Create: `src/utils/project-dirs.test.ts`

This task introduces the helper that `/register`, `/worktree`, and the bridge will all call. No callers yet — we wire them in Tasks 3, 4, and 6.

- [ ] **Step 1: Write failing tests for `listProjectSubdirs`**

Create `src/utils/project-dirs.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Stub the config singleton so we can point BASE_PROJECT_DIR at a tmpdir.
const mockBaseDir = vi.fn<() => string>();
vi.mock("./config.js", () => ({
  getConfig: () => ({ BASE_PROJECT_DIR: mockBaseDir() }),
}));

import {
  listProjectSubdirs,
  resolveProjectPath,
  PathValidationError,
} from "./project-dirs.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "projdirs-"));
  mockBaseDir.mockReturnValue(tmpRoot);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function mkdir(...parts: string[]) {
  fs.mkdirSync(path.join(tmpRoot, ...parts), { recursive: true });
}

describe("listProjectSubdirs — basic walk", () => {
  it("returns subdirs of BASE_PROJECT_DIR for empty focused input", () => {
    mkdir("alpha");
    mkdir("beta");
    mkdir("gamma");
    const result = listProjectSubdirs({ focused: "" });
    expect(result.map((c) => c.value).sort()).toEqual(["alpha", "beta", "gamma"]);
  });

  it("filters by substring match (case-insensitive) on the current path segment", () => {
    mkdir("apple");
    mkdir("banana");
    mkdir("avocado");
    const result = listProjectSubdirs({ focused: "a" });
    // 'a' matches apple, banana (has 'a'), avocado — all three
    expect(result.map((c) => c.value).sort()).toEqual(["apple", "avocado", "banana"]);
  });

  it("descends into nested folders when focused includes a slash", () => {
    mkdir("monorepo", "packages-a");
    mkdir("monorepo", "packages-b");
    mkdir("monorepo", ".hidden");
    const result = listProjectSubdirs({ focused: "monorepo/" });
    expect(result.map((c) => c.value).sort()).toEqual([
      "monorepo/packages-a",
      "monorepo/packages-b",
    ]);
  });

  it("excludes folders whose name starts with '.'", () => {
    mkdir("visible");
    mkdir(".hidden");
    const result = listProjectSubdirs({ focused: "" });
    expect(result.map((c) => c.value)).toEqual(["visible"]);
  });

  it("caps results at 25", () => {
    for (let i = 0; i < 40; i++) mkdir(`dir${String(i).padStart(2, "0")}`);
    const result = listProjectSubdirs({ focused: "" });
    expect(result.length).toBeLessThanOrEqual(25);
  });

  it("returns [] when BASE_PROJECT_DIR doesn't exist", () => {
    mockBaseDir.mockReturnValue(path.join(tmpRoot, "does-not-exist"));
    expect(listProjectSubdirs({ focused: "" })).toEqual([]);
  });

  it("rejects path escapes via '..' by returning []", () => {
    mkdir("alpha");
    expect(listProjectSubdirs({ focused: "../etc/" })).toEqual([]);
  });
});

describe("listProjectSubdirs — includeBaseDirSelf", () => {
  it("prepends '. (BASE_PROJECT_DIR)' when includeBaseDirSelf=true and focused is empty", () => {
    mkdir("alpha");
    const result = listProjectSubdirs({ focused: "", includeBaseDirSelf: true });
    expect(result[0]!.value).toBe(tmpRoot);
    expect(result[0]!.name).toBe(`. (${tmpRoot})`);
  });

  it("omits the base-dir entry when includeBaseDirSelf=false", () => {
    mkdir("alpha");
    const result = listProjectSubdirs({ focused: "", includeBaseDirSelf: false });
    expect(result.some((c) => c.value === tmpRoot)).toBe(false);
  });

  it("omits the base-dir entry once focused is non-empty even with includeBaseDirSelf=true", () => {
    mkdir("alpha");
    const result = listProjectSubdirs({ focused: "al", includeBaseDirSelf: true });
    expect(result.some((c) => c.value === tmpRoot)).toBe(false);
  });
});

describe("listProjectSubdirs — includeCreateNew", () => {
  it("appends 'Create new: <focused>' when no exact match and flag is true", () => {
    mkdir("alpha");
    const result = listProjectSubdirs({ focused: "newproj", includeCreateNew: true });
    const last = result[result.length - 1]!;
    expect(last.name.startsWith("📁 Create new: ")).toBe(true);
    expect(last.value).toBe("newproj");
  });

  it("does NOT append Create new when an exact match exists", () => {
    mkdir("alpha");
    const result = listProjectSubdirs({ focused: "alpha", includeCreateNew: true });
    expect(result.some((c) => c.name.startsWith("📁 Create new:"))).toBe(false);
  });

  it("does NOT append Create new when flag is false (default)", () => {
    mkdir("alpha");
    const result = listProjectSubdirs({ focused: "newproj" });
    expect(result.some((c) => c.name.startsWith("📁 Create new:"))).toBe(false);
  });
});

describe("listProjectSubdirs — starredAbsolutePath (⭐ pin)", () => {
  it("prepends '⭐ <relpath>' when star is inside BASE_PROJECT_DIR and focused is empty", () => {
    mkdir("starred");
    mkdir("other");
    const starAbs = path.join(tmpRoot, "starred");
    const result = listProjectSubdirs({ focused: "", starredAbsolutePath: starAbs });
    expect(result[0]!.name).toBe("⭐ starred");
    expect(result[0]!.value).toBe(starAbs); // absolute, not relative
  });

  it("dedups: walk entry for the same absolute path is dropped", () => {
    mkdir("starred");
    const starAbs = path.join(tmpRoot, "starred");
    const result = listProjectSubdirs({ focused: "", starredAbsolutePath: starAbs });
    // Only one entry for 'starred' — the ⭐ one
    expect(result.filter((c) => c.value === starAbs || c.value === "starred")).toHaveLength(1);
  });

  it("shows absolute path label when star is outside BASE_PROJECT_DIR", () => {
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
    try {
      const result = listProjectSubdirs({ focused: "", starredAbsolutePath: outsideRoot });
      expect(result[0]!.name).toBe(`⭐ ${outsideRoot}`);
      expect(result[0]!.value).toBe(outsideRoot);
    } finally {
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it("does NOT pin ⭐ when focused is non-empty (lets the user filter freely)", () => {
    mkdir("starred");
    mkdir("alpha");
    const starAbs = path.join(tmpRoot, "starred");
    const result = listProjectSubdirs({
      focused: "alp",
      starredAbsolutePath: starAbs,
    });
    expect(result.some((c) => c.name.startsWith("⭐"))).toBe(false);
  });

  it("handles starredAbsolutePath === BASE_PROJECT_DIR (label is '⭐ .')", () => {
    const result = listProjectSubdirs({ focused: "", starredAbsolutePath: tmpRoot });
    expect(result[0]!.name).toBe("⭐ .");
    expect(result[0]!.value).toBe(tmpRoot);
  });
});

describe("resolveProjectPath", () => {
  it("returns absolute input unchanged", () => {
    mockBaseDir.mockReturnValue("/base");
    expect(resolveProjectPath("/abs/path")).toBe("/abs/path");
  });

  it("joins relative input with BASE_PROJECT_DIR", () => {
    mockBaseDir.mockReturnValue("/base");
    expect(resolveProjectPath("foo/bar")).toBe(path.join("/base", "foo/bar"));
  });

  it("returns empty string for empty input", () => {
    expect(resolveProjectPath("")).toBe("");
  });
});

describe("PathValidationError", () => {
  it("is an Error with name 'PathValidationError'", () => {
    const e = new PathValidationError("nope");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("PathValidationError");
    expect(e.message).toBe("nope");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/utils/project-dirs.test.ts`
Expected: FAIL — `project-dirs.ts` doesn't exist yet.

- [ ] **Step 3: Implement `src/utils/project-dirs.ts`**

Create the file with:

```typescript
import fs from "node:fs";
import path from "node:path";
import { getConfig } from "./config.js";

/**
 * Custom error surfaced by the bridge when a path-typed argument fails
 * validation (e.g. contains '..', or a relative path escapes BASE_PROJECT_DIR).
 * Caught in `handlePluginCommand` and rendered as an ephemeral reply.
 */
export class PathValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathValidationError";
  }
}

export interface ProjectDirChoice {
  /** Display label shown in the Discord dropdown. */
  name: string;
  /** Submitted value when the user picks this entry. Relative for walk
   *  entries; absolute for the ⭐ pin and the includeBaseDirSelf entry. */
  value: string;
}

export interface ListProjectSubdirsOptions {
  /** User's typed text so far (Discord's `getFocused()` value). */
  focused: string;
  /** When true and `focused` is empty, prepends `. (BASE_PROJECT_DIR)` —
   *  used by `/register` to allow registering the channel to the base dir
   *  itself. Default false. */
  includeBaseDirSelf?: boolean;
  /** When true and no exact match exists for `focused`, appends a
   *  `📁 Create new: <focused>` entry — used by `/register`. Default false. */
  includeCreateNew?: boolean;
  /** Channel's currently-registered project (absolute path). When provided
   *  AND `focused` is empty, this is pinned at the top with a ⭐. Dedups
   *  against the walk on absolute-path equality. */
  starredAbsolutePath?: string;
}

const MAX_RESULTS = 25;

/**
 * Walk BASE_PROJECT_DIR (or a nested subdir) and return up to 25 choices
 * suitable for `interaction.respond()`. Shared by `/register`, `/worktree`,
 * and the plugin command bridge's autocomplete.
 *
 * Behavior:
 *   - `focused` is split on the LAST '/' — anything before is the parent
 *     subdir to walk; anything after is the filter prefix (substring,
 *     case-insensitive).
 *   - Hidden folders (name starts with '.') are excluded.
 *   - Returns `[]` if the resolved directory escapes BASE_PROJECT_DIR.
 *   - Returns `[]` (silently) if reading fails — caller already responds
 *     with `[]` in that path; we never throw from this function.
 */
export function listProjectSubdirs(
  opts: ListProjectSubdirsOptions,
): ProjectDirChoice[] {
  const { focused, includeBaseDirSelf, includeCreateNew, starredAbsolutePath } = opts;
  const baseDir = getConfig().BASE_PROJECT_DIR;

  try {
    const lastSlash = focused.lastIndexOf("/");
    const parentPart = lastSlash >= 0 ? focused.slice(0, lastSlash) : "";
    const currentPrefix = lastSlash >= 0 ? focused.slice(lastSlash + 1) : focused;

    const listDir = parentPart ? path.join(baseDir, parentPart) : baseDir;

    // Security: must stay within baseDir.
    const resolvedList = path.resolve(listDir);
    const resolvedBase = path.resolve(baseDir);
    if (
      resolvedList !== resolvedBase &&
      !resolvedList.startsWith(resolvedBase + path.sep)
    ) {
      return [];
    }

    if (!fs.existsSync(listDir)) return [];

    const entries = fs.readdirSync(listDir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .filter((name) =>
        name.toLowerCase().includes(currentPrefix.toLowerCase()),
      )
      .slice(0, MAX_RESULTS);

    const choices: ProjectDirChoice[] = [];

    // ⭐ pin — only when focused is empty and a star is provided.
    let starAbs: string | undefined;
    if (starredAbsolutePath && focused === "") {
      starAbs = path.resolve(starredAbsolutePath);
      const relFromBase = path.relative(resolvedBase, starAbs);
      let label: string;
      if (starAbs === resolvedBase) {
        label = ".";
      } else if (!relFromBase.startsWith("..") && !path.isAbsolute(relFromBase)) {
        label = relFromBase;
      } else {
        label = starAbs;
      }
      choices.push({ name: `⭐ ${label}`, value: starAbs });
    }

    // includeBaseDirSelf — same gating as ⭐ (only when focused is empty).
    if (includeBaseDirSelf && focused === "") {
      // Don't duplicate if ⭐ already covers baseDir.
      if (!starAbs || starAbs !== resolvedBase) {
        choices.push({ name: `. (${baseDir})`, value: baseDir });
      }
    }

    for (const name of dirs) {
      const relValue = parentPart ? `${parentPart}/${name}` : name;
      const entryAbs = path.resolve(listDir, name);

      // Dedup against the ⭐ pin on absolute-path equality.
      if (starAbs && entryAbs === starAbs) continue;

      choices.push({ name: relValue, value: relValue });
    }

    if (includeCreateNew && focused) {
      const exactMatch = dirs.some(
        (d) => d.toLowerCase() === currentPrefix.toLowerCase(),
      );
      if (!exactMatch) {
        choices.push({ name: `📁 Create new: ${focused}`, value: focused });
      }
    }

    return choices.slice(0, MAX_RESULTS);
  } catch {
    return [];
  }
}

/**
 * Resolve a path-typed argument value:
 *   - empty → empty (caller decides if missing-arg is an error)
 *   - absolute path → returned as-is (⭐ pin values, user paste)
 *   - relative path → joined with BASE_PROJECT_DIR
 *
 * Does NOT validate '..' or boundary — callers (e.g. the bridge) layer
 * those checks on top.
 */
export function resolveProjectPath(input: string): string {
  if (!input) return "";
  if (path.isAbsolute(input)) return input;
  return path.join(getConfig().BASE_PROJECT_DIR, input);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/utils/project-dirs.test.ts`
Expected: PASS — all 18 assertions.

- [ ] **Step 5: Run `tsc --noEmit` to verify the file type-checks**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/utils/project-dirs.ts src/utils/project-dirs.test.ts
git commit -m "utils: add project-dirs helper for shared autocomplete walk"
```

---

## Task 3: Refactor `/register` to use the shared helper

**Files:**
- Modify: `src/bot/commands/register.ts:86-140`

Behavior must be preserved: still shows `. (BASE_PROJECT_DIR)` at the root and `📁 Create new: <focused>` when no exact match.

- [ ] **Step 1: Replace the autocomplete body**

Edit `src/bot/commands/register.ts`. Replace lines 86–140 (the entire `autocomplete` function) with:

```typescript
export async function autocomplete(
  interaction: AutocompleteInteraction,
): Promise<void> {
  const focused = interaction.options.getFocused();
  const choices = listProjectSubdirs({
    focused,
    includeBaseDirSelf: true,
    includeCreateNew: true,
  });
  await interaction.respond(choices.slice(0, 25));
}
```

Add the import near the top:

```typescript
import { listProjectSubdirs } from "../../utils/project-dirs.js";
```

Remove the now-unused `fs` import line if `fs` is no longer referenced in this file. Check the `execute` function (lines 26–84) first — it still uses `fs.existsSync` and `fs.mkdirSync`, so KEEP the `fs` import.

- [ ] **Step 2: Run `tsc --noEmit`**

Run: `npx tsc --noEmit`
Expected: clean. If TS warns about unused imports, remove them.

- [ ] **Step 3: Manual sanity test (no automated test)**

The autocomplete flow can't be unit-tested in isolation without mocking the Discord interaction. Verify behavior with one of these:

a) Run `npm test` to confirm nothing else broke.
b) Optionally: start the bot (`npm run dev`), open Discord, type `/register path:` and confirm the dropdown lists `. (BASE_PROJECT_DIR)`, subdirs, and `📁 Create new: ...` exactly like before.

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/bot/commands/register.ts
git commit -m "register: use shared project-dirs helper for autocomplete"
```

---

## Task 4: Refactor `/worktree` to use the shared helper

**Files:**
- Modify: `src/bot/commands/worktree.ts:148-185`

- [ ] **Step 1: Replace the autocomplete body**

Edit `src/bot/commands/worktree.ts`. Replace lines 148–185 (the entire `autocomplete` function) with:

```typescript
export async function autocomplete(
  interaction: AutocompleteInteraction,
): Promise<void> {
  const focused = interaction.options.getFocused();
  const choices = listProjectSubdirs({
    focused,
    includeBaseDirSelf: false,
    includeCreateNew: false,
  });
  await interaction.respond(choices.slice(0, 25));
}
```

Add the import:

```typescript
import { listProjectSubdirs } from "../../utils/project-dirs.js";
```

Check whether `fs` is still used in the file (it's used inside `execute`, line 56's `fs.existsSync`). Keep the `fs` import.

- [ ] **Step 2: Run tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 3: Commit**

```bash
git add src/bot/commands/worktree.ts
git commit -m "worktree: use shared project-dirs helper for autocomplete"
```

---

## Task 5: Wire registry to set autocomplete on path-typed params

**Files:**
- Modify: `src/plugins/registry.ts:117-138`
- Modify: `src/plugins/registry.test.ts` (add tests)

- [ ] **Step 1: Write failing tests for the autocomplete flag**

Edit `src/plugins/registry.test.ts`. Find the `param()` helper (around lines 96–103) — it currently emits `type: "text"` (set in Task 1, Step 6). Add an overload:

```typescript
function paramWithType(
  name: string,
  required: boolean,
  originalIndex: number,
  type: "path" | "text",
  description = name,
): ParsedParam {
  return { name, description, required, originalIndex, type };
}
```

Then append these tests to the existing `describe("PluginRegistry.toDiscordCommands", ...)` block:

```typescript
  it("sets autocomplete=true on options whose ParsedParam.type === 'path'", () => {
    registry.register([
      cmdWithParams("p1@m1", "architect", [
        paramWithType("repo-path", true, 0, "path"),
      ]),
    ]);
    const json = registry.toDiscordCommands()[0]!.toJSON();
    expect(json.options).toHaveLength(1);
    expect(json.options![0]).toMatchObject({
      name: "repo-path",
      required: true,
      autocomplete: true,
    });
  });

  it("does NOT set autocomplete on options whose type === 'text'", () => {
    registry.register([
      cmdWithParams("p1@m1", "research", [
        paramWithType("topic", true, 0, "text"),
      ]),
    ]);
    const json = registry.toDiscordCommands()[0]!.toJSON();
    // discord.js omits 'autocomplete' from JSON when not set, so the
    // property is absent (or false). Assert neither truthy.
    expect(json.options![0].autocomplete).not.toBe(true);
  });

  it("does NOT set autocomplete on the fallback `args` option", () => {
    registry.register([cmd("p1@m1", "noargs")]);
    const json = registry.toDiscordCommands()[0]!.toJSON();
    expect(json.options![0].autocomplete).not.toBe(true);
  });

  it("mixes autocomplete and plain options across multiple params", () => {
    registry.register([
      cmdWithParams("p1@m1", "scan", [
        paramWithType("repo", true, 0, "path"),
        paramWithType("query", true, 1, "text"),
      ]),
    ]);
    const json = registry.toDiscordCommands()[0]!.toJSON();
    const byName: Record<string, any> = {};
    for (const o of json.options!) byName[o.name] = o;
    expect(byName.repo.autocomplete).toBe(true);
    expect(byName.query.autocomplete).not.toBe(true);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/plugins/registry.test.ts`
Expected: FAIL on the new tests — registry doesn't call `setAutocomplete` yet.

- [ ] **Step 3: Wire the flag in registry.ts**

Edit `src/plugins/registry.ts`. Replace lines 124–139 (the `else` branch in `toDiscordCommands`) with:

```typescript
      } else {
        // Discord requires required options before optional. Sort by required
        // desc (true first), with originalIndex as the tiebreaker.
        const sorted = [...cmd.parsedParams].sort((a, b) => {
          if (a.required !== b.required) return a.required ? -1 : 1;
          return a.originalIndex - b.originalIndex;
        });
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
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/plugins/registry.test.ts`
Expected: PASS, including the four new assertions.

- [ ] **Step 5: Run the full test suite**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add src/plugins/registry.ts src/plugins/registry.test.ts
git commit -m "registry: attach autocomplete to path-typed plugin command params"
```

---

## Task 6: Add `handlePluginAutocomplete` to the bridge

**Files:**
- Modify: `src/plugins/bridge.ts`
- Modify: `src/plugins/bridge.test.ts`

- [ ] **Step 1: Write failing tests for `handlePluginAutocomplete`**

Edit `src/plugins/bridge.test.ts`. Below the existing `mockSendMessage` mock declarations (around line 6), add:

```typescript
const mockListProjectSubdirs = vi.fn();
const mockResolveProjectPath = vi.fn();

vi.mock("../utils/project-dirs.js", () => ({
  listProjectSubdirs: (opts: any) => mockListProjectSubdirs(opts),
  resolveProjectPath: (input: string) => mockResolveProjectPath(input),
  PathValidationError: class PathValidationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "PathValidationError";
    }
  },
}));
```

After the existing `handlePluginCommand` import on line 20, also import the new handler:

```typescript
import { handlePluginCommand, handlePluginAutocomplete } from "./bridge.js";
import { PluginRegistry } from "./registry.js";
```

Add a helper for autocomplete-style interactions, near `makeInteraction`:

```typescript
function makeAutocompleteInteraction(opts: {
  channelId?: string;
  commandName: string;
  focusedName: string;
  focusedValue: string;
}) {
  return {
    channelId: opts.channelId ?? "chan-1",
    commandName: opts.commandName,
    options: {
      getFocused: (_returnObj: boolean) => ({
        name: opts.focusedName,
        value: opts.focusedValue,
      }),
    },
    respond: vi.fn().mockResolvedValue(undefined),
  };
}

function makeRegistryWith(reg: RegisteredPluginCommand): PluginRegistry {
  const r = new PluginRegistry(new Set());
  // Use the public `register` with a DiscoveredCommand-shaped input.
  r.register([{
    scope: reg.scope,
    pluginName: reg.pluginName,
    pluginShortName: reg.pluginShortName,
    pluginInstallPath: reg.pluginInstallPath,
    projectPath: reg.projectPath,
    commandName: reg.commandName,
    description: reg.description,
    parsedParams: reg.parsedParams,
    sourcePath: reg.sourcePath,
  }]);
  return r;
}
```

Then add a new describe block at the bottom of the file:

```typescript
describe("handlePluginAutocomplete", () => {
  beforeEach(() => {
    mockListProjectSubdirs.mockReset();
    mockGetProject.mockReset();
  });

  it("returns [] for an unknown command name", async () => {
    const registry = makeRegistryWith(reg("known"));
    const interaction = makeAutocompleteInteraction({
      commandName: "unknown",
      focusedName: "x",
      focusedValue: "",
    });
    await handlePluginAutocomplete(interaction as any, registry);
    expect(interaction.respond).toHaveBeenCalledWith([]);
    expect(mockListProjectSubdirs).not.toHaveBeenCalled();
  });

  it("returns [] when focused param is not in parsedParams", async () => {
    const registry = makeRegistryWith(reg("scan", [
      { name: "repo", description: "repo", required: true, originalIndex: 0, type: "path" },
    ]));
    const interaction = makeAutocompleteInteraction({
      commandName: "scan",
      focusedName: "other",
      focusedValue: "",
    });
    await handlePluginAutocomplete(interaction as any, registry);
    expect(interaction.respond).toHaveBeenCalledWith([]);
    expect(mockListProjectSubdirs).not.toHaveBeenCalled();
  });

  it("returns [] when focused param has type !== 'path'", async () => {
    const registry = makeRegistryWith(reg("research", [
      { name: "topic", description: "topic", required: true, originalIndex: 0, type: "text" },
    ]));
    const interaction = makeAutocompleteInteraction({
      commandName: "research",
      focusedName: "topic",
      focusedValue: "",
    });
    await handlePluginAutocomplete(interaction as any, registry);
    expect(interaction.respond).toHaveBeenCalledWith([]);
    expect(mockListProjectSubdirs).not.toHaveBeenCalled();
  });

  it("calls listProjectSubdirs with starredAbsolutePath when channel has a project", async () => {
    mockGetProject.mockReturnValue({ project_path: "/my/proj", channel_id: "chan-1" });
    mockListProjectSubdirs.mockReturnValue([{ name: "x", value: "x" }]);
    const registry = makeRegistryWith(reg("architect", [
      { name: "repo-path", description: "repo-path", required: true, originalIndex: 0, type: "path" },
    ]));
    const interaction = makeAutocompleteInteraction({
      channelId: "chan-1",
      commandName: "architect",
      focusedName: "repo-path",
      focusedValue: "",
    });
    await handlePluginAutocomplete(interaction as any, registry);
    expect(mockListProjectSubdirs).toHaveBeenCalledWith({
      focused: "",
      includeBaseDirSelf: false,
      includeCreateNew: false,
      starredAbsolutePath: "/my/proj",
    });
    expect(interaction.respond).toHaveBeenCalledWith([{ name: "x", value: "x" }]);
  });

  it("omits starredAbsolutePath when channel has no project", async () => {
    mockGetProject.mockReturnValue(undefined);
    mockListProjectSubdirs.mockReturnValue([]);
    const registry = makeRegistryWith(reg("architect", [
      { name: "repo", description: "repo", required: true, originalIndex: 0, type: "path" },
    ]));
    const interaction = makeAutocompleteInteraction({
      channelId: "chan-2",
      commandName: "architect",
      focusedName: "repo",
      focusedValue: "",
    });
    await handlePluginAutocomplete(interaction as any, registry);
    expect(mockListProjectSubdirs).toHaveBeenCalledWith({
      focused: "",
      includeBaseDirSelf: false,
      includeCreateNew: false,
      starredAbsolutePath: undefined,
    });
  });

  it("caps response to first 25 choices", async () => {
    mockGetProject.mockReturnValue(undefined);
    const many = Array.from({ length: 40 }, (_, i) => ({ name: `d${i}`, value: `d${i}` }));
    mockListProjectSubdirs.mockReturnValue(many);
    const registry = makeRegistryWith(reg("architect", [
      { name: "repo", description: "repo", required: true, originalIndex: 0, type: "path" },
    ]));
    const interaction = makeAutocompleteInteraction({
      commandName: "architect",
      focusedName: "repo",
      focusedValue: "",
    });
    await handlePluginAutocomplete(interaction as any, registry);
    const respondArg = interaction.respond.mock.calls[0][0];
    expect(respondArg).toHaveLength(25);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/plugins/bridge.test.ts`
Expected: FAIL — `handlePluginAutocomplete` doesn't exist.

- [ ] **Step 3: Implement `handlePluginAutocomplete` in `bridge.ts`**

Edit `src/plugins/bridge.ts`. After the existing imports (top of file), add:

```typescript
import type { AutocompleteInteraction } from "discord.js";
import { listProjectSubdirs } from "../utils/project-dirs.js";
import { PluginRegistry } from "./registry.js";
```

After the existing `handlePluginCommand` export, add:

```typescript
/**
 * Discord slash-command autocomplete handler for plugin-derived commands.
 *
 * client.ts dispatches here when the focused interaction targets a command
 * that lives in `pluginRegistry` (i.e. not a bot-owned command). The handler
 * inspects the focused param's `type`; only path-typed params get the
 * BASE_PROJECT_DIR walk. Everything else returns [].
 */
export async function handlePluginAutocomplete(
  interaction: AutocompleteInteraction,
  registry: PluginRegistry,
): Promise<void> {
  const registered = registry.lookup(interaction.commandName);
  if (!registered) {
    await interaction.respond([]);
    return;
  }

  const focused = interaction.options.getFocused(true);
  const param = registered.parsedParams.find((p) => p.name === focused.name);
  if (!param || param.type !== "path") {
    await interaction.respond([]);
    return;
  }

  const project = getProject(interaction.channelId);
  const choices = listProjectSubdirs({
    focused: focused.value,
    includeBaseDirSelf: false,
    includeCreateNew: false,
    starredAbsolutePath: project?.project_path,
  });

  await interaction.respond(choices.slice(0, 25));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/plugins/bridge.test.ts`
Expected: PASS for the new describe block. Existing tests still pass.

- [ ] **Step 5: Run `tsc --noEmit`**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/plugins/bridge.ts src/plugins/bridge.test.ts
git commit -m "bridge: add handlePluginAutocomplete for path-typed plugin params"
```

---

## Task 7: Extend `buildPrompt` to resolve path-typed args + safety checks

**Files:**
- Modify: `src/plugins/bridge.ts:58-91` (`buildPrompt` + `handlePluginCommand`)
- Modify: `src/plugins/bridge.test.ts`

The bridge's `buildPrompt` must resolve relative path-typed inputs to absolute paths, reject `..`, and reject relative paths that escape `BASE_PROJECT_DIR`. `PathValidationError` is caught in `handlePluginCommand` and surfaced as an ephemeral reply.

- [ ] **Step 1: Write failing tests for path resolution + validation**

In `src/plugins/bridge.test.ts`, inside the existing test suite that exercises `handlePluginCommand` and `buildPrompt`, add these tests. (Find the describe block that contains `mockSendMessage` assertions; if none exists for buildPrompt directly, put these inside a new describe.)

```typescript
describe("buildPrompt — path-typed arg resolution", () => {
  beforeEach(() => {
    mockResolveProjectPath.mockReset();
    mockGetProject.mockReturnValue({ project_path: "/any", channel_id: "chan-1" });
    mockIsActive.mockReturnValue(false);
    mockSendMessage.mockReset();
  });

  it("resolves a relative path-typed value to absolute and dispatches", async () => {
    mockResolveProjectPath.mockImplementation((v: string) =>
      v.startsWith("/") ? v : `/base/${v}`,
    );
    const registry = makeRegistryWith(reg("architect", [
      { name: "repo", description: "repo", required: true, originalIndex: 0, type: "path" },
    ]));
    const interaction = makeInteraction({
      channelId: "chan-1",
      options: { repo: "monorepo/foo" },
    });
    // commandName needs to match the registered command
    interaction.commandName = "architect";
    await handlePluginCommand(interaction as any, registry.lookup("architect")!);
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.anything(),
      "/claude-obsidian:architect /base/monorepo/foo",
    );
  });

  it("passes absolute path-typed values through without joining base", async () => {
    mockResolveProjectPath.mockImplementation((v: string) =>
      v.startsWith("/") ? v : `/base/${v}`,
    );
    const registry = makeRegistryWith(reg("architect", [
      { name: "repo", description: "repo", required: true, originalIndex: 0, type: "path" },
    ]));
    const interaction = makeInteraction({
      channelId: "chan-1",
      options: { repo: "/elsewhere/repo" },
    });
    interaction.commandName = "architect";
    await handlePluginCommand(interaction as any, registry.lookup("architect")!);
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.anything(),
      "/claude-obsidian:architect /elsewhere/repo",
    );
  });

  it("rejects '..' in any path-typed value with ephemeral reply, no dispatch", async () => {
    const registry = makeRegistryWith(reg("architect", [
      { name: "repo", description: "repo", required: true, originalIndex: 0, type: "path" },
    ]));
    const interaction = makeInteraction({
      channelId: "chan-1",
      options: { repo: "../etc" },
    });
    interaction.commandName = "architect";
    await handlePluginCommand(interaction as any, registry.lookup("architect")!);
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Invalid path"),
      }),
    );
  });

  it("does not resolve text-typed values", async () => {
    const registry = makeRegistryWith(reg("research", [
      { name: "topic", description: "topic", required: true, originalIndex: 0, type: "text" },
    ]));
    const interaction = makeInteraction({
      channelId: "chan-1",
      options: { topic: "AI safety" },
    });
    interaction.commandName = "research";
    await handlePluginCommand(interaction as any, registry.lookup("research")!);
    expect(mockResolveProjectPath).not.toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.anything(),
      "/claude-obsidian:research AI safety",
    );
  });
});
```

> Note on the `'escape BASE_PROJECT_DIR'` check: in unit tests the base-dir check would need a real `path.resolve` chain, which is hard to mock cleanly through `resolveProjectPath`. We get the same coverage via `src/utils/project-dirs.test.ts` (the helper) plus a manual smoke test in Step 5 below. If you want unit coverage for the bridge's boundary check, do it by NOT mocking `resolveProjectPath` and supplying a real BASE_PROJECT_DIR via the config mock — see the existing bridge.test.ts patterns.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/plugins/bridge.test.ts`
Expected: FAIL — `buildPrompt` doesn't yet resolve paths or throw.

- [ ] **Step 3: Update `buildPrompt` + `handlePluginCommand`**

Edit `src/plugins/bridge.ts`. Add to the imports at the top of the file:

```typescript
import path from "node:path";
import { getConfig } from "../utils/config.js";
import {
  listProjectSubdirs,
  resolveProjectPath,
  PathValidationError,
} from "../utils/project-dirs.js";
```

(`listProjectSubdirs` was already added in Task 6 — combine the imports.)

Replace `buildPrompt` (lines 58–91) with:

```typescript
function buildPrompt(
  interaction: ChatInputCommandInteraction,
  registered: RegisteredPluginCommand,
): string {
  const slashName =
    registered.scope === "plugin"
      ? `${registered.pluginShortName}:${registered.commandName}`
      : registered.commandName;

  if (registered.parsedParams.length === 0) {
    const args = (interaction.options.getString("args") ?? "").trim();
    return args ? `/${slashName} ${args}` : `/${slashName}`;
  }

  const sorted = [...registered.parsedParams].sort(
    (a, b) => a.originalIndex - b.originalIndex,
  );
  const values: string[] = [];
  for (const p of sorted) {
    const raw = (interaction.options.getString(p.name) ?? "").trim();
    if (p.type === "path") {
      values.push(resolvePathArg(raw));
    } else {
      values.push(raw);
    }
  }
  while (values.length > 0 && values[values.length - 1] === "") {
    values.pop();
  }
  const joined = values.join(" ");
  return joined ? `/${slashName} ${joined}` : `/${slashName}`;
}

/**
 * Resolve a single path-typed argument value with safety checks.
 *
 * Rules:
 *   - empty → "" (caller's Discord schema enforces required)
 *   - contains ".." → PathValidationError (no further processing)
 *   - absolute → returned as-is (⭐ pin, power-user paste; matches /register
 *     tolerance for channels registered outside BASE_PROJECT_DIR)
 *   - relative → joined with BASE_PROJECT_DIR; result MUST stay inside
 *     BASE_PROJECT_DIR or PathValidationError
 */
function resolvePathArg(raw: string): string {
  if (!raw) return "";
  if (raw.includes("..")) {
    throw new PathValidationError("path must not contain '..'");
  }
  const resolved = resolveProjectPath(raw);
  if (!path.isAbsolute(raw)) {
    const baseDir = path.resolve(getConfig().BASE_PROJECT_DIR);
    const candidate = path.resolve(resolved);
    if (candidate !== baseDir && !candidate.startsWith(baseDir + path.sep)) {
      throw new PathValidationError("path escapes base project directory");
    }
  }
  return resolved;
}
```

Update `handlePluginCommand` to catch `PathValidationError`. Replace lines 22–56 (the entire function) with:

```typescript
export async function handlePluginCommand(
  interaction: ChatInputCommandInteraction,
  registered: RegisteredPluginCommand,
): Promise<void> {
  const channelId = interaction.channelId;

  if (!getProject(channelId)) {
    await interaction.editReply({
      content: L(
        "This channel is not registered to a project. Run `/register` first.",
        "이 채널은 프로젝트에 등록되지 않았습니다. 먼저 `/register`를 사용하세요.",
      ),
    });
    return;
  }

  if (sessionManager.isActive(channelId)) {
    await interaction.editReply({
      content: L(
        "A task is already in progress in this channel. Wait for it to finish or use `/stop`.",
        "이 채널에서 이미 작업이 진행 중입니다. 완료될 때까지 기다리거나 `/stop`을 사용하세요.",
      ),
    });
    return;
  }

  let prompt: string;
  try {
    prompt = buildPrompt(interaction, registered);
  } catch (err) {
    if (err instanceof PathValidationError) {
      await interaction.editReply({
        content: L(
          `Invalid path: ${err.message}`,
          `잘못된 경로: ${err.message}`,
        ),
      });
      return;
    }
    throw err;
  }

  await interaction.editReply({
    content: L(`Running \`${prompt}\``, `실행 중: \`${prompt}\``),
  });

  const channel = interaction.channel as TextChannel;
  await sessionManager.sendMessage(channel, prompt);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/plugins/bridge.test.ts`
Expected: PASS, including the new path-resolution tests.

- [ ] **Step 5: Run the full test suite + tsc**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add src/plugins/bridge.ts src/plugins/bridge.test.ts
git commit -m "bridge: resolve path-typed args to absolute paths, reject '..' and escapes"
```

---

## Task 8: Wire client.ts autocomplete dispatch to fall through to plugin bridge

**Files:**
- Modify: `src/bot/client.ts:120-129`

- [ ] **Step 1: Inspect the surrounding context first**

Before editing, confirm where `pluginRegistry` is in scope inside `client.ts`. It should be imported or constructed in this file. Read lines 1–100 if you haven't already to locate it.

- [ ] **Step 2: Extend the autocomplete dispatch**

Edit `src/bot/client.ts`. Replace lines 120–129 (the `interaction.isAutocomplete()` block inside `interactionCreate`) with:

```typescript
      if (interaction.isAutocomplete()) {
        const command = commandMap.get(interaction.commandName);
        if (command && "autocomplete" in command) {
          await (command as any).autocomplete(interaction);
          return;
        }
        // Fall through: a plugin-derived command may have registered
        // autocomplete via setAutocomplete(true) on a path-typed param.
        if (pluginRegistry.lookup(interaction.commandName)) {
          await handlePluginAutocomplete(interaction, pluginRegistry);
        }
        return;
      }
```

Add to the imports at the top of the file:

```typescript
import { handlePluginAutocomplete } from "../plugins/bridge.js";
```

(If `handlePluginCommand` is already imported from the same path, append `handlePluginAutocomplete` to the same import statement instead of adding a new line.)

- [ ] **Step 3: Run the full test suite**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS, clean. No tests directly exercise `client.ts` autocomplete dispatch in isolation, but TS will flag wiring mistakes.

- [ ] **Step 4: Manual smoke test**

Bring up the bot:

```bash
npm run dev
```

In Discord:

1. `/register` — pick an existing folder. Confirm the dropdown still shows `. (BASE_PROJECT_DIR)` + subdirs + `📁 Create new: ...`.
2. Find a plugin command with a path-typed param. The cleanest test case is the `obsidian-architect` command (named `repo-path` per its frontmatter, which matches `PATH_PARAM_NAMES`).
   - Type `/obsidian-architect ` and tab into the `repo-path` field. Expect a dropdown with `⭐ <current channel project>` at the top, followed by other `BASE_PROJECT_DIR` subdirs. No `📁 Create new` entry.
   - Pick the ⭐ entry. Confirm the bot dispatches `/<plugin>:<command> <absolute path>` to Claude (visible in the running progress message).
3. Type a non-path-typed plugin command (e.g. `/research`). Confirm the `topic` field has NO dropdown — autocomplete returns empty.
4. Try entering `../etc` into a path-typed field. Confirm the bot replies with `Invalid path: path must not contain '..'` and does NOT dispatch to Claude.

- [ ] **Step 5: Commit**

```bash
git add src/bot/client.ts
git commit -m "client: dispatch autocomplete to plugin bridge for path-typed params"
```

---

## Final verification

- [ ] **Step 1: Run the full test suite once more**

Run: `npx vitest run`
Expected: PASS, all suites green.

- [ ] **Step 2: Run the build**

Run: `npm run build`
Expected: clean build with no TS errors.

- [ ] **Step 3: Confirm git log is clean**

Run: `git log --oneline -10`
Expected: 8 atomic commits, one per task, matching the messages above. No "WIP" or "fixup" entries.

- [ ] **Step 4: Open `docs/superpowers/specs/2026-05-26-plugin-path-autocomplete-design.md` and walk each spec section against the commits**

For each section in the spec — Detection, Data model, Shared helper, Registry, Bridge autocomplete, Bridge buildPrompt, Client dispatch, Star pin, Error model — confirm there's a commit that implements it. If any gap, that's a missing task.

- [ ] **Step 5: Hand off to user for visual smoke test**

The implementation is complete. The user should do a final smoke test in Discord and confirm the UX matches the spec's data flow diagram.
