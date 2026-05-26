import fs from "node:fs";
import path from "node:path";
import { getConfig } from "./config.js";

/**
 * Custom error surfaced by the bridge when a path-typed argument fails
 * validation (e.g. contains '..', or a relative path escapes BASE_PROJECT_DIR).
 * Caught in `handlePluginCommand` and rendered as an ephemeral reply.
 */
export class PathValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathValidationError";
  }
}

export interface ProjectDirChoice {
  /** Display label shown in the Discord dropdown. */
  name: string;
  /** Submitted value when the user picks this entry. Relative for walk
   *  entries; absolute for the ⭐ pin and the includeBaseDirSelf entry. */
  value: string;
}

export interface ListProjectSubdirsOptions {
  /** User's typed text so far (Discord's `getFocused()` value). */
  focused: string;
  /** When true and `focused` is empty, prepends `. (BASE_PROJECT_DIR)` —
   *  used by `/register` to allow registering the channel to the base dir
   *  itself. Default false. */
  includeBaseDirSelf?: boolean;
  /** When true and no exact match exists for `focused`, appends a
   *  `📁 Create new: <focused>` entry — used by `/register`. Default false. */
  includeCreateNew?: boolean;
  /** Channel's currently-registered project (absolute path). When provided
   *  AND `focused` is empty, this is pinned at the top with a ⭐. Dedups
   *  against the walk on absolute-path equality. */
  starredAbsolutePath?: string;
}

const MAX_RESULTS = 25;

/**
 * Walk BASE_PROJECT_DIR (or a nested subdir) and return up to 25 choices
 * suitable for `interaction.respond()`. Shared by `/register`, `/worktree`,
 * and the plugin command bridge's autocomplete.
 *
 * Behavior:
 *   - `focused` is split on the LAST '/' — anything before is the parent
 *     subdir to walk; anything after is the filter prefix (substring,
 *     case-insensitive).
 *   - Hidden folders (name starts with '.') are excluded.
 *   - Returns `[]` if the resolved directory escapes BASE_PROJECT_DIR.
 *   - Returns `[]` (silently) if reading fails — caller already responds
 *     with `[]` in that path; we never throw from this function.
 */
export function listProjectSubdirs(
  opts: ListProjectSubdirsOptions,
): ProjectDirChoice[] {
  const { focused, includeBaseDirSelf, includeCreateNew, starredAbsolutePath } = opts;
  const baseDir = getConfig().BASE_PROJECT_DIR;

  try {
    const lastSlash = focused.lastIndexOf("/");
    const parentPart = lastSlash >= 0 ? focused.slice(0, lastSlash) : "";
    const currentPrefix = lastSlash >= 0 ? focused.slice(lastSlash + 1) : focused;

    const listDir = parentPart ? path.join(baseDir, parentPart) : baseDir;

    // Security: must stay within baseDir.
    const resolvedList = path.resolve(listDir);
    const resolvedBase = path.resolve(baseDir);
    if (
      resolvedList !== resolvedBase &&
      !resolvedList.startsWith(resolvedBase + path.sep)
    ) {
      return [];
    }

    if (!fs.existsSync(listDir)) return [];

    const entries = fs.readdirSync(listDir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .filter((name) =>
        name.toLowerCase().includes(currentPrefix.toLowerCase()),
      );

    const choices: ProjectDirChoice[] = [];

    // ⭐ pin — only when focused is empty and a star is provided.
    let starAbs: string | undefined;
    if (starredAbsolutePath && focused === "") {
      starAbs = path.resolve(starredAbsolutePath);
      const relFromBase = path.relative(resolvedBase, starAbs);
      let label: string;
      if (starAbs === resolvedBase) {
        label = ".";
      } else if (!relFromBase.startsWith("..") && !path.isAbsolute(relFromBase)) {
        label = relFromBase;
      } else {
        label = starAbs;
      }
      choices.push({ name: `⭐ ${label}`, value: starAbs });
    }

    // includeBaseDirSelf — only when focused is empty. The old /register
    // autocomplete also showed this entry when the user typed a substring of
    // baseDir itself (e.g. typing "/pro" with baseDir="/home/user/projects"
    // would surface it). That branch surprised more than it helped — we
    // deliberately tighten the condition here.
    if (includeBaseDirSelf && focused === "") {
      // Don't duplicate if ⭐ already covers baseDir.
      if (!starAbs || starAbs !== resolvedBase) {
        choices.push({ name: `. (${baseDir})`, value: baseDir });
      }
    }

    const reserveForCreateNew = includeCreateNew && focused ? 1 : 0;
    for (const name of dirs) {
      if (choices.length >= MAX_RESULTS - reserveForCreateNew) break;
      const relValue = parentPart ? `${parentPart}/${name}` : name;
      const entryAbs = path.resolve(listDir, name);

      // Dedup against the ⭐ pin on absolute-path equality.
      if (starAbs && entryAbs === starAbs) continue;

      choices.push({ name: relValue, value: relValue });
    }

    if (includeCreateNew && focused) {
      const exactMatch = dirs.some(
        (d) => d.toLowerCase() === currentPrefix.toLowerCase(),
      );
      if (!exactMatch) {
        choices.push({ name: `📁 Create new: ${focused}`, value: focused });
      }
    }

    return choices.slice(0, MAX_RESULTS);
  } catch {
    return [];
  }
}

/**
 * Resolve a path-typed argument value:
 *   - empty → empty (caller decides if missing-arg is an error)
 *   - absolute path → returned as-is (⭐ pin values, user paste)
 *   - relative path → joined with BASE_PROJECT_DIR
 *
 * Does NOT validate '..' or boundary — callers (e.g. the bridge) layer
 * those checks on top.
 */
export function resolveProjectPath(input: string): string {
  if (!input) return "";
  if (path.isAbsolute(input)) return input;
  return path.join(getConfig().BASE_PROJECT_DIR, input);
}
