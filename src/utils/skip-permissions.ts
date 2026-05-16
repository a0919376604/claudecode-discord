import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolves to <botDir>/.skip-permissions when running from dist/index.js.
// Exported so the tray apps' documentation can reference the same path
// without hardcoding it elsewhere in TS.
export const SKIP_PERMISSIONS_FILE = path.join(__dirname, "..", ".skip-permissions");

/**
 * Returns true if the sidecar file at `filePath` (defaults to
 * `<botDir>/.skip-permissions`) contains exactly `true` (after trim).
 * Any read error, missing file, or other content returns false — safer default.
 */
export function isSkipPermissionsEnabled(filePath: string = SKIP_PERMISSIONS_FILE): boolean {
  try {
    return fs.readFileSync(filePath, "utf-8").trim() === "true";
  } catch {
    return false;
  }
}
