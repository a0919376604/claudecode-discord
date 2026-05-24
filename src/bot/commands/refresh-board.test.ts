import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Re-import the module fresh per test so CODE_ROOT can be set via env.
// We use dynamic import after mutating env so the constant captures the right value.

async function freshImport() {
  // bust module cache
  const url = new URL("./refresh-board.ts", import.meta.url).href;
  return await import(`${url}?t=${Date.now()}`);
}

describe("refresh-board", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "refresh-board-test-"));
    process.env.CODE_ROOT = tmpRoot;
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.CODE_ROOT;
  });

  describe("listEligibleRepos", () => {
    it("returns only directories whose .git is a real directory", async () => {
      // Real repo: dir with .git/ subdir
      fs.mkdirSync(path.join(tmpRoot, "real-repo", ".git"), { recursive: true });
      // Worktree: dir with .git as a FILE (pointer)
      fs.mkdirSync(path.join(tmpRoot, "worktree-sibling"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, "worktree-sibling", ".git"),
        "gitdir: /elsewhere/.git/worktrees/x\n",
      );
      // Random dir without .git at all
      fs.mkdirSync(path.join(tmpRoot, "not-a-repo"), { recursive: true });
      // Hidden dir
      fs.mkdirSync(path.join(tmpRoot, ".cache", ".git"), { recursive: true });

      const { __testing } = await freshImport();
      const repos = __testing.listEligibleRepos();

      expect(repos).toEqual(["real-repo"]);
    });

    it("returns sorted basenames", async () => {
      for (const name of ["zebra", "alpha", "mango"]) {
        fs.mkdirSync(path.join(tmpRoot, name, ".git"), { recursive: true });
      }
      const { __testing } = await freshImport();
      expect(__testing.listEligibleRepos()).toEqual(["alpha", "mango", "zebra"]);
    });

    it("returns [] when CODE_ROOT does not exist", async () => {
      process.env.CODE_ROOT = path.join(tmpRoot, "nope");
      const { __testing } = await freshImport();
      expect(__testing.listEligibleRepos()).toEqual([]);
    });
  });

  describe("isValidRepoName", () => {
    it("accepts conventional repo names", async () => {
      const { __testing } = await freshImport();
      const ok = ["langlive-line-oa", "claudecode-discord", "abc_123", "a.b.c"];
      for (const name of ok) {
        expect(__testing.isValidRepoName(name)).toBe(true);
      }
    });

    it("rejects path traversal and shell metacharacters", async () => {
      const { __testing } = await freshImport();
      const bad = [
        "..",
        "../etc",
        "a/b",
        "a;rm -rf /",
        "$(whoami)",
        "a b",
        "",
        ".hidden",
        "foo..bar",
      ];
      for (const name of bad) {
        expect(__testing.isValidRepoName(name)).toBe(false);
      }
    });
  });
});
