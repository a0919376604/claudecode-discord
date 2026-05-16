# `/worktree` Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Discord slash command `/worktree path:<source-repo>` that creates a git worktree off an existing repo, registers the new path to the current channel, and makes `/unregister` clean up worktree folders automatically.

**Architecture:** New slash command file mirrors `/register` but adds a `git worktree add` step before persisting. The `projects` SQLite table gains a `source_path` column (NULL for normal `/register` rows, set for worktree rows) so `/unregister` can branch on it and run `git worktree remove --force` for cleanup. Git interactions live in a new `src/utils/git.ts` module so they can be unit-tested against a real git repo in a temp dir.

**Tech Stack:** TypeScript ESM, discord.js v14, better-sqlite3, node:child_process (`execFileSync` — no shell), vitest. No new dependencies.

**Spec:** [`docs/superpowers/specs/2026-05-16-worktree-command-design.md`](../specs/2026-05-16-worktree-command-design.md)

---

## File Structure

**Create:**
- `src/utils/git.ts` — git repo detection, `git worktree add`, `git worktree remove`, branch existence check, next-available worktree name picker
- `src/utils/git.test.ts` — unit tests against a real git repo in a temp dir
- `src/bot/commands/worktree.ts` — the `/worktree` slash command (data, execute, autocomplete)

**Modify:**
- `src/db/types.ts` — add `source_path: string | null` to `Project`
- `src/db/database.ts` — add `source_path` column to `CREATE TABLE`, idempotent migration via `PRAGMA table_info`, new `registerWorktreeProject` helper
- `src/db/database.test.ts` — tests for the new column, migration, and helper
- `src/bot/commands/unregister.ts` — when `project.source_path` is set, run `git worktree remove --force` then fall back to `fs.rmSync`
- `src/bot/client.ts` — import and register the new command

---

## Task 1: DB schema — add `source_path` column and helper

**Files:**
- Modify: `src/db/types.ts`
- Modify: `src/db/database.ts`
- Modify: `src/db/database.test.ts`

- [ ] **Step 1.1: Add failing test for `source_path` on a fresh DB**

Append inside the existing `describe("project CRUD", ...)` block in `src/db/database.test.ts`:

```typescript
it("registerProject sets source_path to NULL by default", () => {
  registerProject("ch1", "/p1", "guild1");
  const project = getProject("ch1");
  expect(project!.source_path).toBeNull();
});
```

- [ ] **Step 1.2: Run the test and watch it fail**

Run: `npx vitest run src/db/database.test.ts`
Expected: FAIL with `Property 'source_path' does not exist on type 'Project'` (TypeScript) or `undefined` at runtime.

- [ ] **Step 1.3: Add `source_path` to the `Project` type**

In `src/db/types.ts`, change the `Project` interface to:

```typescript
export interface Project {
  channel_id: string;
  project_path: string;
  guild_id: string;
  auto_approve: number; // 0 or 1
  source_path: string | null; // NULL for /register, absolute path for /worktree
  created_at: string;
}
```

- [ ] **Step 1.4: Add `source_path` to `CREATE TABLE` in `database.ts`**

In `src/db/database.ts`, edit the `db.exec(...)` inside `initDatabase()` so the `projects` table reads:

```sql
CREATE TABLE IF NOT EXISTS projects (
  channel_id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  auto_approve INTEGER DEFAULT 0,
  source_path TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
```

(Keep the `sessions` table block exactly as it is.)

- [ ] **Step 1.5: Add idempotent migration after the `db.exec(...)` block**

Immediately after the `db.exec(...)` call in `initDatabase()`, add:

```typescript
// Migration: add source_path column for installations created before /worktree.
// Safe to re-run; only ALTERs when the column is missing.
const cols = db
  .prepare("PRAGMA table_info(projects)")
  .all() as Array<{ name: string }>;
if (!cols.some((c) => c.name === "source_path")) {
  db.exec("ALTER TABLE projects ADD COLUMN source_path TEXT");
}
```

- [ ] **Step 1.6: Run the test and watch it pass**

Run: `npx vitest run src/db/database.test.ts`
Expected: PASS for the new `source_path` test plus all existing tests.

- [ ] **Step 1.7: Add failing test for the migration path**

The vitest mock at `src/db/database.test.ts:4-13` makes every `initDatabase()` return a fresh `:memory:` DB, so we can't exercise migration by calling `initDatabase()` twice. Instead, test the migration logic directly against a separately-constructed `:memory:` DB.

Append a new `describe` block at the bottom of `src/db/database.test.ts`:

```typescript
describe("source_path migration", () => {
  it("ALTER TABLE adds source_path when missing", async () => {
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE projects (
        channel_id TEXT PRIMARY KEY,
        project_path TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        auto_approve INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
    const before = db
      .prepare("PRAGMA table_info(projects)")
      .all() as Array<{ name: string }>;
    expect(before.some((c) => c.name === "source_path")).toBe(false);

    // Mirror the migration block from initDatabase().
    const cols = db
      .prepare("PRAGMA table_info(projects)")
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "source_path")) {
      db.exec("ALTER TABLE projects ADD COLUMN source_path TEXT");
    }

    const after = db
      .prepare("PRAGMA table_info(projects)")
      .all() as Array<{ name: string }>;
    expect(after.some((c) => c.name === "source_path")).toBe(true);
  });
});
```

This test passes immediately because the migration block in `initDatabase()` was added in Step 1.5. It exists to lock in the behavior so future schema changes can't accidentally regress upgrade flows.

- [ ] **Step 1.8: Run the migration test**

Run: `npx vitest run src/db/database.test.ts -t "source_path migration"`
Expected: PASS.

- [ ] **Step 1.9: Add failing test for `registerWorktreeProject`**

Append inside `describe("project CRUD", ...)`:

```typescript
it("registerWorktreeProject stores source_path", () => {
  registerWorktreeProject("ch1", "/wt/path", "guild1", "/src/path");
  const project = getProject("ch1");
  expect(project!.project_path).toBe("/wt/path");
  expect(project!.source_path).toBe("/src/path");
});
```

Update the top-level import list in `database.test.ts` to include `registerWorktreeProject`.

- [ ] **Step 1.10: Run the test and watch it fail**

Run: `npx vitest run src/db/database.test.ts -t "registerWorktreeProject"`
Expected: FAIL — `registerWorktreeProject is not a function`.

- [ ] **Step 1.11: Implement `registerWorktreeProject` in `database.ts`**

Add directly below the existing `registerProject` function in `src/db/database.ts`:

```typescript
export function registerWorktreeProject(
  channelId: string,
  projectPath: string,
  guildId: string,
  sourcePath: string,
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO projects (channel_id, project_path, guild_id, source_path)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(channelId, projectPath, guildId, sourcePath);
}
```

- [ ] **Step 1.12: Run the test and watch it pass**

Run: `npx vitest run src/db/database.test.ts`
Expected: PASS for all database tests.

- [ ] **Step 1.13: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 1.14: Commit**

```bash
git add src/db/types.ts src/db/database.ts src/db/database.test.ts
git commit -m "Add source_path column and registerWorktreeProject helper"
```

---

## Task 2: Git utility module — `isGitRepo` + branch / worktree existence checks

**Files:**
- Create: `src/utils/git.ts`
- Create: `src/utils/git.test.ts`

- [ ] **Step 2.1: Write failing test for `isGitRepo`**

Create `src/utils/git.test.ts` with:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { isGitRepo } from "./git.js";

let tmpRoot: string;
let repoDir: string;
let plainDir: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "git-utils-test-"));
  repoDir = path.join(tmpRoot, "repo");
  plainDir = path.join(tmpRoot, "plain");
  fs.mkdirSync(repoDir);
  fs.mkdirSync(plainDir);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoDir });
  // Make a single commit so HEAD is valid (worktree add -b needs a base commit).
  fs.writeFileSync(path.join(repoDir, "README.md"), "hello\n");
  execFileSync("git", ["-C", repoDir, "add", "."]);
  execFileSync("git", ["-C", repoDir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("isGitRepo", () => {
  it("returns true for a git repo", () => {
    expect(isGitRepo(repoDir)).toBe(true);
  });

  it("returns false for a plain directory", () => {
    expect(isGitRepo(plainDir)).toBe(false);
  });

  it("returns false for a non-existent path", () => {
    expect(isGitRepo(path.join(tmpRoot, "nope"))).toBe(false);
  });
});
```

- [ ] **Step 2.2: Run the test and watch it fail**

Run: `npx vitest run src/utils/git.test.ts`
Expected: FAIL — module `./git.js` cannot be found.

- [ ] **Step 2.3: Create `src/utils/git.ts` with `isGitRepo`**

```typescript
import fs from "node:fs";
import path from "node:path";

/**
 * Returns true if `dir` exists and contains a `.git` entry (either a directory
 * for a normal repo, or a file for a linked worktree).
 */
export function isGitRepo(dir: string): boolean {
  try {
    if (!fs.existsSync(dir)) return false;
    if (!fs.statSync(dir).isDirectory()) return false;
    const gitPath = path.join(dir, ".git");
    return fs.existsSync(gitPath);
  } catch {
    return false;
  }
}
```

- [ ] **Step 2.4: Run the test and watch it pass**

Run: `npx vitest run src/utils/git.test.ts`
Expected: PASS for the three `isGitRepo` tests.

- [ ] **Step 2.5: Add failing test for `branchExists`**

Append to `src/utils/git.test.ts`:

```typescript
import { branchExists } from "./git.js";

describe("branchExists", () => {
  it("returns true for an existing branch", () => {
    expect(branchExists(repoDir, "main")).toBe(true);
  });

  it("returns false for a non-existent branch", () => {
    expect(branchExists(repoDir, "does-not-exist")).toBe(false);
  });
});
```

(Merge the import into the existing import statement.)

- [ ] **Step 2.6: Run the test and watch it fail**

Run: `npx vitest run src/utils/git.test.ts -t "branchExists"`
Expected: FAIL — `branchExists` is not exported.

- [ ] **Step 2.7: Implement `branchExists`**

Append to `src/utils/git.ts`:

```typescript
import { execFileSync } from "node:child_process";

/**
 * Returns true if `branch` exists in the git repo at `repoDir`.
 * Uses `git rev-parse --verify --quiet refs/heads/<branch>` which exits 0 if
 * the ref exists and 1 otherwise.
 */
export function branchExists(repoDir: string, branch: string): boolean {
  try {
    execFileSync("git", ["-C", repoDir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}
```

Move the `execFileSync` import to the top of the file with the other imports.

- [ ] **Step 2.8: Run the test and watch it pass**

Run: `npx vitest run src/utils/git.test.ts -t "branchExists"`
Expected: PASS.

- [ ] **Step 2.9: Commit**

```bash
git add src/utils/git.ts src/utils/git.test.ts
git commit -m "Add git utility module with isGitRepo and branchExists"
```

---

## Task 3: Git utility — `addWorktree` and `removeWorktree`

**Files:**
- Modify: `src/utils/git.ts`
- Modify: `src/utils/git.test.ts`

- [ ] **Step 3.1: Write failing test for `addWorktree`**

Append to `src/utils/git.test.ts`:

```typescript
import { addWorktree } from "./git.js";

describe("addWorktree", () => {
  it("creates a worktree at the given path with the given new branch", () => {
    const wtPath = path.join(tmpRoot, "repo-wt-test");
    addWorktree(repoDir, "feat-test", wtPath);

    expect(fs.existsSync(wtPath)).toBe(true);
    expect(fs.existsSync(path.join(wtPath, ".git"))).toBe(true);
    expect(fs.existsSync(path.join(wtPath, "README.md"))).toBe(true);

    // Branch exists in source repo
    expect(branchExists(repoDir, "feat-test")).toBe(true);
  });

  it("throws when the worktree path already exists", () => {
    const wtPath = path.join(tmpRoot, "already-there");
    fs.mkdirSync(wtPath);
    expect(() => addWorktree(repoDir, "feat-collision", wtPath)).toThrow();
  });
});
```

- [ ] **Step 3.2: Run the test and watch it fail**

Run: `npx vitest run src/utils/git.test.ts -t "addWorktree"`
Expected: FAIL — `addWorktree` is not exported.

- [ ] **Step 3.3: Implement `addWorktree`**

Append to `src/utils/git.ts`:

```typescript
/**
 * Create a new worktree at `worktreePath` checked out to a brand-new branch
 * `branchName` based on the source repo's current HEAD.
 * Throws if git fails (e.g. branch exists, path exists, source isn't a repo).
 */
export function addWorktree(
  repoDir: string,
  branchName: string,
  worktreePath: string,
): void {
  execFileSync(
    "git",
    ["-C", repoDir, "worktree", "add", "-b", branchName, worktreePath],
    { stdio: "pipe" },
  );
}
```

- [ ] **Step 3.4: Run the test and watch it pass**

Run: `npx vitest run src/utils/git.test.ts -t "addWorktree"`
Expected: PASS.

- [ ] **Step 3.5: Write failing test for `removeWorktree`**

Append to `src/utils/git.test.ts`:

```typescript
import { removeWorktree } from "./git.js";

describe("removeWorktree", () => {
  it("removes a worktree folder and git metadata", () => {
    const wtPath = path.join(tmpRoot, "repo-wt-rm");
    addWorktree(repoDir, "feat-rm", wtPath);
    expect(fs.existsSync(wtPath)).toBe(true);

    removeWorktree(repoDir, wtPath);
    expect(fs.existsSync(wtPath)).toBe(false);
  });

  it("force-removes even with uncommitted changes", () => {
    const wtPath = path.join(tmpRoot, "repo-wt-dirty");
    addWorktree(repoDir, "feat-dirty", wtPath);
    fs.writeFileSync(path.join(wtPath, "scratch.txt"), "uncommitted\n");

    // Should not throw despite dirty state.
    removeWorktree(repoDir, wtPath);
    expect(fs.existsSync(wtPath)).toBe(false);
  });
});
```

- [ ] **Step 3.6: Run the test and watch it fail**

Run: `npx vitest run src/utils/git.test.ts -t "removeWorktree"`
Expected: FAIL — `removeWorktree` is not exported.

- [ ] **Step 3.7: Implement `removeWorktree`**

Append to `src/utils/git.ts`:

```typescript
/**
 * Remove a worktree using `git worktree remove --force`, which deletes the
 * folder, cleans up git's worktree metadata, and discards any uncommitted
 * changes inside the worktree. The source repo and its branches are left
 * untouched (the branch the worktree was checked out to is preserved).
 */
export function removeWorktree(repoDir: string, worktreePath: string): void {
  execFileSync(
    "git",
    ["-C", repoDir, "worktree", "remove", "--force", worktreePath],
    { stdio: "pipe" },
  );
}
```

- [ ] **Step 3.8: Run the test and watch it pass**

Run: `npx vitest run src/utils/git.test.ts -t "removeWorktree"`
Expected: PASS for both `removeWorktree` cases.

- [ ] **Step 3.9: Commit**

```bash
git add src/utils/git.ts src/utils/git.test.ts
git commit -m "Add addWorktree and removeWorktree git helpers"
```

---

## Task 4: Worktree name picker — `pickNextWorktreeName`

**Files:**
- Modify: `src/utils/git.ts`
- Modify: `src/utils/git.test.ts`

- [ ] **Step 4.1: Write failing test for `pickNextWorktreeName`**

Append to `src/utils/git.test.ts`:

```typescript
import { pickNextWorktreeName } from "./git.js";

describe("pickNextWorktreeName", () => {
  it("returns -wt-1 when no candidate exists", () => {
    // Use a fresh repo so the test is isolated from sibling state.
    const isoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wt-name-"));
    const repo = path.join(isoRoot, "myrepo");
    fs.mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "f"), "x");
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "i"]);

    const { branchName, worktreePath } = pickNextWorktreeName(repo);
    expect(branchName).toBe("myrepo-wt-1");
    expect(worktreePath).toBe(path.join(isoRoot, "myrepo-wt-1"));

    fs.rmSync(isoRoot, { recursive: true, force: true });
  });

  it("skips numbers whose folder already exists", () => {
    const isoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wt-name-"));
    const repo = path.join(isoRoot, "myrepo");
    fs.mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "f"), "x");
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "i"]);

    fs.mkdirSync(path.join(isoRoot, "myrepo-wt-1"));
    fs.mkdirSync(path.join(isoRoot, "myrepo-wt-2"));

    const { branchName } = pickNextWorktreeName(repo);
    expect(branchName).toBe("myrepo-wt-3");

    fs.rmSync(isoRoot, { recursive: true, force: true });
  });

  it("skips numbers whose branch already exists", () => {
    const isoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wt-name-"));
    const repo = path.join(isoRoot, "myrepo");
    fs.mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "f"), "x");
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "i"]);
    execFileSync("git", ["-C", repo, "branch", "myrepo-wt-1"]);

    const { branchName } = pickNextWorktreeName(repo);
    expect(branchName).toBe("myrepo-wt-2");

    fs.rmSync(isoRoot, { recursive: true, force: true });
  });
});
```

- [ ] **Step 4.2: Run the test and watch it fail**

Run: `npx vitest run src/utils/git.test.ts -t "pickNextWorktreeName"`
Expected: FAIL — `pickNextWorktreeName` is not exported.

- [ ] **Step 4.3: Implement `pickNextWorktreeName`**

Append to `src/utils/git.ts`:

```typescript
/**
 * Pick the next available `<basename>-wt-N` (N = 1, 2, 3, ...) such that both
 * the folder at `<source-parent>/<basename>-wt-N` does not exist AND the
 * branch `<basename>-wt-N` does not exist in the source repo.
 *
 * Returns the absolute worktree path and the matching branch name.
 */
export function pickNextWorktreeName(sourceRepo: string): {
  branchName: string;
  worktreePath: string;
} {
  const basename = path.basename(sourceRepo);
  const parent = path.dirname(sourceRepo);
  for (let n = 1; n < 10_000; n++) {
    const branchName = `${basename}-wt-${n}`;
    const worktreePath = path.join(parent, branchName);
    if (!fs.existsSync(worktreePath) && !branchExists(sourceRepo, branchName)) {
      return { branchName, worktreePath };
    }
  }
  throw new Error(`Could not find an available worktree name for ${sourceRepo}`);
}
```

- [ ] **Step 4.4: Run the test and watch it pass**

Run: `npx vitest run src/utils/git.test.ts`
Expected: PASS for all `pickNextWorktreeName` cases plus all earlier tests.

- [ ] **Step 4.5: Commit**

```bash
git add src/utils/git.ts src/utils/git.test.ts
git commit -m "Add pickNextWorktreeName helper"
```

---

## Task 5: `/worktree` slash command

**Files:**
- Create: `src/bot/commands/worktree.ts`

- [ ] **Step 5.1: Create `src/bot/commands/worktree.ts`**

Note: the autocomplete logic is copied verbatim from `register.ts` (lines 86–140) because it has the same UX requirement — both commands let the user pick a folder under `BASE_PROJECT_DIR`. Duplication is intentional: trying to share would require an unrelated refactor.

```typescript
import {
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  SlashCommandBuilder,
  PermissionFlagsBits,
} from "discord.js";
import fs from "node:fs";
import path from "node:path";
import { registerWorktreeProject, getProject } from "../../db/database.js";
import { validateProjectPath } from "../../security/guard.js";
import { getConfig } from "../../utils/config.js";
import { L } from "../../utils/i18n.js";
import {
  isGitRepo,
  addWorktree,
  removeWorktree,
  pickNextWorktreeName,
} from "../../utils/git.js";

export const data = new SlashCommandBuilder()
  .setName("worktree")
  .setDescription("Create a git worktree of a project and register this channel to it")
  .addStringOption((opt) =>
    opt
      .setName("path")
      .setDescription(`Source repo folder name (${getConfig().BASE_PROJECT_DIR})`)
      .setRequired(true)
      .setAutocomplete(true),
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const input = interaction.options.getString("path", true);
  const config = getConfig();
  const sourcePath = path.isAbsolute(input)
    ? input
    : path.join(config.BASE_PROJECT_DIR, input);
  const channelId = interaction.channelId;
  const guildId = interaction.guildId!;

  // Reject if channel already registered (mirrors /register).
  const existing = getProject(channelId);
  if (existing) {
    await interaction.editReply({
      content: L(
        `This channel is already registered to \`${existing.project_path}\`. Use \`/unregister\` first.`,
        `이 채널은 이미 \`${existing.project_path}\`에 등록되어 있습니다. 먼저 \`/unregister\`를 사용하세요.`,
      ),
    });
    return;
  }

  // Source must exist and be a git repo.
  if (!fs.existsSync(sourcePath)) {
    await interaction.editReply({
      content: L(
        `Source path does not exist: \`${sourcePath}\``,
        `소스 경로가 존재하지 않습니다: \`${sourcePath}\``,
      ),
    });
    return;
  }
  if (!isGitRepo(sourcePath)) {
    await interaction.editReply({
      content: L(
        `Source path is not a git repository: \`${sourcePath}\``,
        `소스 경로는 git 저장소가 아닙니다: \`${sourcePath}\``,
      ),
    });
    return;
  }

  // Pick the next available worktree name + path.
  const { branchName, worktreePath } = pickNextWorktreeName(sourcePath);

  // Create the worktree.
  try {
    addWorktree(sourcePath, branchName, worktreePath);
  } catch (err) {
    await interaction.editReply({
      content: L(
        `git worktree add failed: ${(err as Error).message}`,
        `git worktree add 실패: ${(err as Error).message}`,
      ),
    });
    return;
  }

  // Now that the worktree folder exists, run the standard project-path validation.
  const validationError = validateProjectPath(worktreePath);
  if (validationError) {
    // The worktree was created but is outside the allowed area — roll it back
    // so we don't leave orphan state.
    try {
      removeWorktree(sourcePath, worktreePath);
    } catch {
      // Best-effort cleanup; original validation error is the real failure.
    }
    await interaction.editReply({
      content: L(
        `Invalid worktree path: ${validationError}`,
        `잘못된 worktree 경로: ${validationError}`,
      ),
    });
    return;
  }

  registerWorktreeProject(channelId, worktreePath, guildId, sourcePath);

  await interaction.editReply({
    embeds: [
      {
        title: L("Worktree Created", "Worktree 생성됨"),
        description: L(
          `This channel is now linked to:\n\`${worktreePath}\``,
          `이 채널이 연결되었습니다:\n\`${worktreePath}\``,
        ),
        color: 0x00ff00,
        fields: [
          {
            name: L("Worktree of", "원본 프로젝트"),
            value: `\`${sourcePath}\``,
            inline: false,
          },
          {
            name: L("Branch", "브랜치"),
            value: `\`${branchName}\``,
            inline: true,
          },
          {
            name: L("Status", "상태"),
            value: L("🔴 Offline", "🔴 오프라인"),
            inline: true,
          },
          {
            name: L("Auto-approve", "자동 승인"),
            value: L("Off", "꺼짐"),
            inline: true,
          },
        ],
      },
    ],
  });
}

export async function autocomplete(
  interaction: AutocompleteInteraction,
): Promise<void> {
  const focused = interaction.options.getFocused();
  const config = getConfig();
  const baseDir = config.BASE_PROJECT_DIR;

  try {
    const lastSlash = focused.lastIndexOf("/");
    const parentPart = lastSlash >= 0 ? focused.slice(0, lastSlash) : "";
    const currentPrefix = lastSlash >= 0 ? focused.slice(lastSlash + 1) : focused;

    const listDir = parentPart ? path.join(baseDir, parentPart) : baseDir;

    const resolvedList = path.resolve(listDir);
    const resolvedBase = path.resolve(baseDir);
    if (!resolvedList.startsWith(resolvedBase)) {
      await interaction.respond([]);
      return;
    }

    const entries = fs.readdirSync(listDir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .filter((name) => name.toLowerCase().includes(currentPrefix.toLowerCase()))
      .slice(0, 25);

    const choices = dirs.map((name) => {
      const value = parentPart ? `${parentPart}/${name}` : name;
      return { name: value, value };
    });

    await interaction.respond(choices.slice(0, 25));
  } catch {
    await interaction.respond([]);
  }
}
```

- [ ] **Step 5.2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5.3: Commit**

```bash
git add src/bot/commands/worktree.ts
git commit -m "Add /worktree slash command"
```

---

## Task 6: Wire `/worktree` into the client

**Files:**
- Modify: `src/bot/client.ts`

- [ ] **Step 6.1: Add the import**

In `src/bot/client.ts`, add to the import block after `unregisterCmd`:

```typescript
import * as worktreeCmd from "./commands/worktree.js";
```

- [ ] **Step 6.2: Add to the `commands` array**

Change the `commands` array on line 28 to include `worktreeCmd` right after `unregisterCmd`:

```typescript
const commands = [registerCmd, unregisterCmd, worktreeCmd, statusCmd, stopCmd, autoApproveCmd, sessionsCmd, clearSessionsCmd, lastCmd, queueCmd, usageCmd];
```

- [ ] **Step 6.3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6.4: Commit**

```bash
git add src/bot/client.ts
git commit -m "Register /worktree command in client"
```

---

## Task 7: `/unregister` cleans up worktrees

**Files:**
- Modify: `src/bot/commands/unregister.ts`

- [ ] **Step 7.1: Rewrite `execute` to branch on `source_path`**

Replace the body of `src/bot/commands/unregister.ts` with:

```typescript
import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  PermissionFlagsBits,
} from "discord.js";
import fs from "node:fs";
import { unregisterProject, getProject } from "../../db/database.js";
import { sessionManager } from "../../claude/session-manager.js";
import { removeWorktree } from "../../utils/git.js";
import { L } from "../../utils/i18n.js";

export const data = new SlashCommandBuilder()
  .setName("unregister")
  .setDescription("Unregister this channel from its project")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const channelId = interaction.channelId;
  const project = getProject(channelId);

  if (!project) {
    await interaction.editReply({
      content: L(
        "This channel is not registered to any project.",
        "이 채널은 어떤 프로젝트에도 등록되어 있지 않습니다.",
      ),
    });
    return;
  }

  // Stop active session first so the worktree files aren't held open.
  await sessionManager.stopSession(channelId);

  // Worktree cleanup: only for channels created by /worktree.
  let worktreeCleanupNote = "";
  if (project.source_path) {
    try {
      removeWorktree(project.source_path, project.project_path);
      worktreeCleanupNote = L(
        `\nWorktree folder removed: \`${project.project_path}\``,
        `\nWorktree 폴더 삭제됨: \`${project.project_path}\``,
      );
    } catch {
      // git worktree remove failed (source repo gone, metadata broken, etc.)
      // Fall back to deleting the folder directly so the channel is left clean.
      try {
        fs.rmSync(project.project_path, { recursive: true, force: true });
        worktreeCleanupNote = L(
          `\nWorktree folder removed (forced): \`${project.project_path}\``,
          `\nWorktree 폴더 강제 삭제됨: \`${project.project_path}\``,
        );
      } catch (rmErr) {
        worktreeCleanupNote = L(
          `\nWarning: could not remove worktree folder \`${project.project_path}\`: ${(rmErr as Error).message}`,
          `\n경고: worktree 폴더 \`${project.project_path}\`를 삭제하지 못했습니다: ${(rmErr as Error).message}`,
        );
      }
    }
  }

  unregisterProject(channelId);

  await interaction.editReply({
    embeds: [
      {
        title: L("Project Unregistered", "프로젝트 등록 해제됨"),
        description:
          L(
            `Removed link to \`${project.project_path}\``,
            `\`${project.project_path}\` 연결이 해제되었습니다`,
          ) + worktreeCleanupNote,
        color: 0xff0000,
      },
    ],
  });
}
```

- [ ] **Step 7.2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7.3: Run the full test suite to confirm nothing regressed**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 7.4: Commit**

```bash
git add src/bot/commands/unregister.ts
git commit -m "Clean up worktree folders on /unregister"
```

---

## Task 8: Manual smoke test

The remaining verification requires a real Discord bot and a real git repo because the slash-command surface and discord.js objects are not unit-tested in this project. Treat this as the final integration check.

**Files:** none (manual test)

- [ ] **Step 8.1: Build and run**

```bash
npm run build
npm start
```

Expected: bot logs in and registers 11 slash commands (was 10).

- [ ] **Step 8.2: Prepare a source repo under `BASE_PROJECT_DIR`**

In a separate terminal, ensure there's a git repo with at least one commit at `<BASE_PROJECT_DIR>/sample-repo` (any small repo works — even `git init && touch f && git add . && git -c user.email=t -c user.name=t commit -m i`).

- [ ] **Step 8.3: Run `/worktree path:sample-repo` in a Discord channel**

In a channel **not yet registered**:

```
/worktree path:sample-repo
```

Expected:
- Embed titled "Worktree Created"
- `Worktree of: <BASE_PROJECT_DIR>/sample-repo`
- `Branch: sample-repo-wt-1`
- The folder `<BASE_PROJECT_DIR>/sample-repo-wt-1` now exists with the source repo's files
- `git -C <BASE_PROJECT_DIR>/sample-repo worktree list` shows the new worktree

- [ ] **Step 8.4: Send a message in the channel**

Send any message (e.g. `list files`). Expected: a Claude session starts against `<BASE_PROJECT_DIR>/sample-repo-wt-1`.

- [ ] **Step 8.5: Run `/unregister` in the same channel**

```
/unregister
```

Expected:
- Embed titled "Project Unregistered"
- Description mentions `Worktree folder removed: <BASE_PROJECT_DIR>/sample-repo-wt-1`
- The folder is gone from disk
- `git -C <BASE_PROJECT_DIR>/sample-repo worktree list` no longer lists it
- The branch `sample-repo-wt-1` still exists in the source repo (worktree remove preserves the branch)

- [ ] **Step 8.6: Verify `/unregister` does NOT delete a `/register` folder**

In another channel:

```
/register path:sample-repo
/unregister
```

Expected: embed mentions only "Removed link to ..." — no "Worktree folder removed" line. The `<BASE_PROJECT_DIR>/sample-repo` folder is still on disk.

- [ ] **Step 8.7: Verify migration on an existing install**

Optional: run the new build against an existing `data.db` from a previous version (back it up first). Expected: bot starts cleanly, `PRAGMA table_info(projects)` now shows `source_path`, all existing projects continue to work as `/register`-style entries (source_path = NULL).

---

## Self-Review Notes

- **Spec coverage:** Every section of the spec maps to a task — DB column + migration (Task 1), git utilities (Tasks 2–4), `/worktree` command including security checks and reply embed (Task 5), client wiring (Task 6), `/unregister` cleanup (Task 7), manual end-to-end verification (Task 8). i18n is applied in Tasks 5 and 7 via the existing `L()` helper.
- **No placeholders:** Each step contains the full code or command. No "implement later" or "similar to above."
- **Type consistency:** `registerWorktreeProject(channelId, projectPath, guildId, sourcePath)` is declared in Task 1.11 and used in Task 5.1 with matching argument order. `pickNextWorktreeName` returns `{ branchName, worktreePath }` in Task 4.3 and is destructured the same way in Task 5.1. `isGitRepo`, `addWorktree`, `removeWorktree` signatures match between declaration and use.
- **Known compromise:** Task 5.1 duplicates the autocomplete logic from `register.ts`. Extracting to a shared helper is out of scope; mentioned inline so the next reader understands the intent.
