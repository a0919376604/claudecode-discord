import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

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
