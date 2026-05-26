import type { ParsedParam } from "./types.js";

/**
 * Parse a `argument-hint:` frontmatter value into Discord parameter slots.
 *
 * Grammar:
 *   hint     := slot (whitespace+ slot)*
 *   slot     := required | optional
 *   required := "<" name (:type)? (whitespace description)? ">"
 *   optional := "[" name (:type)? (whitespace description)? "]"
 *
 * Returns an empty array when the hint is empty, whitespace, or contains no
 * bracketed slots — the caller falls back to a single `args` parameter.
 *
 * See spec for full semantics including sanitization, dupes, 25-param cap,
 * and unclosed-bracket handling. This function is pure (no I/O).
 */

// Matches a single slot: [name] or <name> with optional :type annotation
// and optional inline description. The :type token is a separate capture so
// we can interpret it without breaking the existing name char class.
// The description body excludes all bracket characters so an unclosed
// opener (e.g. "[topic <unclosed [file]") doesn't swallow a later valid slot.
// NOTE: the name and colon must be adjacent (no whitespace before the colon);
// whitespace after the colon is permitted (<name: type>). Writing '<name :text>'
// does NOT produce a type annotation — ' :text' is treated as description text.
const SLOT_RE =
  /([<\[])\s*([A-Za-z][A-Za-z0-9_-]*)(?::\s*([A-Za-z][A-Za-z0-9_-]*))?(?:\s+([^<>\[\]]*))?\s*([>\]])/g;

const MAX_PARAMS = 25;
const MAX_DESC_LEN = 100;

/**
 * Param names whose presence in `argument-hint` causes the bridge to attach
 * a BASE_PROJECT_DIR autocomplete dropdown in Discord. Case-insensitive
 * (matched against the already-lowercased baseName).
 *
 * Plugin authors can override on a per-slot basis with explicit `<name:type>`
 * syntax — e.g. `<topic:path>` forces path on a non-convention name, and
 * `<path:text>` opts a convention name out.
 */
const PATH_PARAM_NAMES = new Set([
  "repo",
  "repo-path",
  "path",
  "project",
  "project-path",
  "dir",
  "directory",
]);

function truncateDescription(desc: string): string {
  if (desc.length <= MAX_DESC_LEN) return desc;
  return desc.slice(0, MAX_DESC_LEN - 3) + "...";
}

export function parseArgumentHint(hint: string): ParsedParam[] {
  if (!hint || !hint.trim()) return [];

  const params: ParsedParam[] = [];
  const seenNames = new Map<string, number>();
  let match: RegExpExecArray | null;
  let index = 0;

  SLOT_RE.lastIndex = 0;
  while ((match = SLOT_RE.exec(hint)) !== null) {
    if (params.length >= MAX_PARAMS) break;

    const [, openBracket, rawName, rawTypeToken, rawDesc = "", closeBracket] = match;
    // Bracket pair must match (no mixing < with ])
    const isRequired = openBracket === "<" && closeBracket === ">";
    const isOptional = openBracket === "[" && closeBracket === "]";
    if (!isRequired && !isOptional) continue;

    const baseName = rawName.toLowerCase();
    const seen = seenNames.get(baseName) ?? 0;
    seenNames.set(baseName, seen + 1);
    const name = seen === 0 ? baseName : `${baseName}_${seen + 1}`;

    const description = truncateDescription(rawDesc.trim() || baseName);

    // Type resolution: explicit :type wins when it's a known token;
    // otherwise fall back to name convention; otherwise "text".
    let type: "path" | "text";
    if (rawTypeToken === "path" || rawTypeToken === "text") {
      type = rawTypeToken;
    } else if (PATH_PARAM_NAMES.has(baseName)) {
      type = "path";
    } else {
      type = "text";
    }

    params.push({
      name,
      description,
      required: isRequired,
      originalIndex: index,
      type,
    });
    index++;
  }

  return params;
}
