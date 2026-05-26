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

  it("does not drop walk entries when ⭐ pin would push total past 25", () => {
    // 25 dirs + 1 ⭐ pin (not in dirs) should still return exactly 25 entries,
    // and the ⭐ pin should be present (it's the prepended one).
    for (let i = 0; i < 25; i++) mkdir(`d${String(i).padStart(2, "0")}`);
    // Star points to a dir OUTSIDE baseDir so it doesn't dedup against the walk.
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
    try {
      const result = listProjectSubdirs({
        focused: "",
        starredAbsolutePath: outsideRoot,
      });
      expect(result).toHaveLength(25);
      // ⭐ pin must be present
      expect(result[0]!.name).toBe(`⭐ ${outsideRoot}`);
      // 24 walk entries (5 dropped from 25 to make room for ⭐ pin — actually
      // it's 24 because 25 - 1 ⭐ = 24)
      const walkEntries = result.filter((c) => c.name.startsWith("d"));
      expect(walkEntries).toHaveLength(24);
    } finally {
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
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
