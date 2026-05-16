# `/worktree` Command Design

Date: 2026-05-16
Status: Approved (pending implementation plan)

## Summary

Add a new Discord slash command `/worktree path:<source-repo>` that creates a new
git worktree from an existing project and registers the new worktree path to the
current Discord channel — like `/register`, but with an extra git step at the
front and a matching cleanup step in `/unregister`.

The current `/register` requires the user to have already created or cloned a
project folder. `/worktree` extends this so a user can spin up an isolated
working copy of an existing repo from Discord in one command, run a session
against it, and have the folder automatically removed when the channel is
unregistered.

## User-facing behaviour

### `/worktree path:<source-repo>`

- Same admin-only permission as `/register`.
- `path` parameter follows the same convention as `/register`:
  - Relative path → resolved as `BASE_PROJECT_DIR/<path>`
  - Absolute path → used as-is
- Autocomplete lists folders under `BASE_PROJECT_DIR` (same UX as `/register`).
  No special filtering for git-repo-only at the autocomplete layer — invalid
  selections are rejected at execution time.
- On success the bot replies with an embed:
  - Title: **Worktree Created**
  - Description: the new worktree path
  - Field: `Worktree of: <source repo path>`
  - Same status / auto-approve fields as the `/register` reply

### `/unregister` (modified behaviour)

- For channels registered by `/worktree` (DB row has `source_path` set):
  1. Stop any active Claude session (existing logic).
  2. Run `git worktree remove --force <project_path>` from the source repo.
  3. If the git command fails (e.g. source repo deleted or git metadata
     corrupted), fall back to `fs.rmSync(project_path, { recursive: true,
     force: true })`.
  4. Remove the channel record from the DB.
  - Reply embed mentions that the worktree folder was deleted.
- For channels registered by `/register` (no `source_path`): behaviour is
  unchanged — the folder is **not** deleted.

## Execution flow for `/worktree`

1. Reject if the channel is already registered (existing pattern, prompts the
   user to `/unregister` first).
2. Resolve `path` to an absolute source repo path.
3. Validate source repo:
   - Path exists and is a directory.
   - It is a git repo (check that `<source>/.git` exists — either a directory
     or a file in the case of nested worktrees).
4. Compute new worktree path and branch name:
   - Let `base = path.basename(source)`.
   - Find the smallest `N ≥ 1` such that both
     - `<source-parent>/<base>-wt-<N>` does **not** exist on disk, **and**
     - branch `<base>-wt-<N>` does **not** exist in the source repo
       (`git -C <source> rev-parse --verify --quiet <branch>`).
   - The new worktree path stays in the same parent directory as the source.
5. Run `git -C <source> worktree add -b <base>-wt-<N> <new-path>`. The new
   branch is created from the source repo's current `HEAD`.
6. Run the existing `validateProjectPath()` security check on the new path
   (must stay within `BASE_PROJECT_DIR`, no `..` traversal).
7. Persist to DB: `registerWorktreeProject(channelId, newPath, guildId,
   sourcePath)`.
8. Reply with the success embed.

If any step from 3–7 fails, no DB row is written and any partial git state is
left to git's own cleanup (we do not aggressively rollback `git worktree add`
on later validation failure because such failures should not occur after step
6 succeeds; the order above prevents that).

## Data model changes

`projects` table gains one column:

```
source_path TEXT  -- NULL for /register channels, absolute path for /worktree channels
```

The `Project` TypeScript type gains `source_path: string | null`.

### Migration

Because this project is public OSS and existing users must upgrade cleanly with
no manual steps (per CLAUDE.md's "no manual intervention" principle),
`initDatabase()` runs an idempotent migration after `CREATE TABLE IF NOT
EXISTS`:

1. Query `PRAGMA table_info(projects)`.
2. If the result does not include `source_path`, run
   `ALTER TABLE projects ADD COLUMN source_path TEXT`.

This is safe to re-run and works for both fresh installs and upgrades.

### New DB helpers

- `registerWorktreeProject(channelId, projectPath, guildId, sourcePath)` —
  same as `registerProject` but writes `source_path`.
- Existing `registerProject` keeps its current signature; the new column
  defaults to NULL for those rows.
- `getProject` already returns the full row; consumers just read
  `project.source_path`.

## Files to change

- **New** `src/bot/commands/worktree.ts` — the new slash command, including
  the same autocomplete handler as `/register`.
- **Modify** `src/bot/commands/unregister.ts` — branch on `source_path`:
  run `git worktree remove --force` then fall back to `fs.rmSync` on failure.
- **Modify** `src/db/database.ts` — add the migration and
  `registerWorktreeProject`.
- **Modify** `src/db/types.ts` — extend the `Project` interface.
- **Modify** `src/bot/client.ts` — import and register the new command in the
  `commands` array (Discord auto-registers all entries on connect).

## Security and edge cases

- **Path traversal** — new worktree path is validated by
  `validateProjectPath()`; must stay within `BASE_PROJECT_DIR`.
- **Command injection** — invoke git via `execFile("git", [...])` (or
  `spawn`) with array args, never through a shell. Source path and worktree
  path are passed as separate argv entries.
- **Not a git repo** — detected at step 3, returns a clear error message and
  does not touch git or the DB.
- **Nested worktrees** — if `source` is itself a worktree, `git worktree add`
  still works against its main repo; this is acceptable.
- **Collisions** — both the new folder name and the new branch name are
  bumped in lockstep, so we never overwrite either.
- **Concurrent sessions on `/unregister`** — handled by existing
  `sessionManager.stopSession()` call.
- **Force-removal trade-off** — `git worktree remove --force` will discard
  uncommitted changes in the worktree. This matches the user's explicit
  intent ("一起刪掉那個 worktree 的資料夾路徑"), and is consistent with
  treating a worktree as ephemeral working space tied to a Discord channel.

## What this design does NOT do

- Does not let the user pick a branch name (auto-derived from folder name).
- Does not let the user pick a parent directory other than the source repo's
  sibling location.
- Does not modify `/register` behaviour or DB rows that were created by
  `/register`.
- Does not add a UI to list worktrees separately from regular projects
  (existing `/status`, `/sessions`, etc. continue to work uniformly; the only
  visible difference is in the `/unregister` cleanup behaviour).
- Does not auto-prune dangling worktrees on bot startup (out of scope; the
  fallback `fs.rmSync` in `/unregister` keeps things consistent for the
  channel being unregistered).

## i18n

This repo uses `L(en, ko)` for all user-facing strings. The new command and
modified `/unregister` messages must include both English and Korean copy
following the existing pattern in `register.ts` / `unregister.ts`.
