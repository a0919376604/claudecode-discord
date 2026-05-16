import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

function gitErrorMessage(err: unknown): string {
  const e = err as { stderr?: Buffer; stdout?: Buffer; message?: string };
  const stderr = e.stderr?.toString().trim();
  if (stderr) return stderr;
  const stdout = e.stdout?.toString().trim();
  if (stdout) return stdout;
  return e.message ?? String(err);
}

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

/**
 * Create a new worktree at `worktreePath` checked out to a brand-new branch
 * `branchName` based on the source repo's current HEAD.
 * Throws if the target path already exists or if git fails (e.g. branch
 * exists, source isn't a repo). The pre-check protects against newer git
 * versions that silently accept an existing empty directory as the target.
 */
export function addWorktree(
  repoDir: string,
  branchName: string,
  worktreePath: string,
): void {
  if (fs.existsSync(worktreePath)) {
    throw new Error(`worktree path already exists: ${worktreePath}`);
  }
  try {
    execFileSync(
      "git",
      ["-C", repoDir, "worktree", "add", "-b", branchName, worktreePath],
      { stdio: "pipe" },
    );
  } catch (err) {
    throw new Error(`git worktree add failed: ${gitErrorMessage(err)}`);
  }
}

/**
 * Remove a worktree using `git worktree remove --force`, which deletes the
 * folder, cleans up git's worktree metadata, and discards any uncommitted
 * changes inside the worktree. The source repo and its branches are left
 * untouched (the branch the worktree was checked out to is preserved).
 */
export function removeWorktree(repoDir: string, worktreePath: string): void {
  try {
    execFileSync(
      "git",
      ["-C", repoDir, "worktree", "remove", "--force", worktreePath],
      { stdio: "pipe" },
    );
  } catch (err) {
    throw new Error(`git worktree remove failed: ${gitErrorMessage(err)}`);
  }
}
