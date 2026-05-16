import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { isGitRepo, branchExists, addWorktree, removeWorktree, pickNextWorktreeName } from "./git.js";

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

describe("branchExists", () => {
  it("returns true for an existing branch", () => {
    expect(branchExists(repoDir, "main")).toBe(true);
  });

  it("returns false for a non-existent branch", () => {
    expect(branchExists(repoDir, "does-not-exist")).toBe(false);
  });
});

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

  it("throws with git's stderr message when target isn't a worktree", () => {
    const notAWorktree = path.join(tmpRoot, "not-a-worktree");
    fs.mkdirSync(notAWorktree);
    expect(() => removeWorktree(repoDir, notAWorktree)).toThrow(/worktree/i);
  });
});

describe("pickNextWorktreeName", () => {
  it("returns -wt-1 when no candidate exists", () => {
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
