import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { isGitRepo, branchExists } from "./git.js";

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
