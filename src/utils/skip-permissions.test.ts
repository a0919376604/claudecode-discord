import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { isSkipPermissionsEnabled } from "./skip-permissions.js";

let tmpDir: string;
let flagPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skip-perms-"));
  flagPath = path.join(tmpDir, ".skip-permissions");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("isSkipPermissionsEnabled", () => {
  it("returns false when file does not exist", () => {
    expect(isSkipPermissionsEnabled(flagPath)).toBe(false);
  });

  it("returns true when file content (trimmed) is exactly 'true'", () => {
    fs.writeFileSync(flagPath, "true\n");
    expect(isSkipPermissionsEnabled(flagPath)).toBe(true);
  });

  it("returns false when file content is 'false'", () => {
    fs.writeFileSync(flagPath, "false");
    expect(isSkipPermissionsEnabled(flagPath)).toBe(false);
  });

  it("returns false when file content is anything other than 'true'", () => {
    fs.writeFileSync(flagPath, "yes");
    expect(isSkipPermissionsEnabled(flagPath)).toBe(false);
  });

  it("returns false when content trims to empty", () => {
    fs.writeFileSync(flagPath, "   \n  \n");
    expect(isSkipPermissionsEnabled(flagPath)).toBe(false);
  });

  it("returns false when the file is unreadable (path is a directory)", () => {
    expect(isSkipPermissionsEnabled(tmpDir)).toBe(false);
  });
});
