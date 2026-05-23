import type { ParsedParam } from "./types.js";

/**
 * Parse a `argument-hint:` frontmatter value into Discord parameter slots.
 *
 * Grammar:
 *   hint     := slot (whitespace+ slot)*
 *   slot     := required | optional
 *   required := "<" name (whitespace description)? ">"
 *   optional := "[" name (whitespace description)? "]"
 *
 * Returns an empty array when the hint is empty, whitespace, or contains no
 * bracketed slots — the caller falls back to a single `args` parameter.
 *
 * See spec for full semantics including sanitization, dupes, 25-param cap,
 * and unclosed-bracket handling. This function is pure (no I/O).
 */

// Matches a single slot: [name] or <name> with optional description after name.
// The description body excludes all bracket characters so that an unclosed
// opener (e.g. "[topic <unclosed [file]") doesn't swallow a later valid slot.
const SLOT_RE =
  /([<\[])\s*([A-Za-z][A-Za-z0-9_-]*)(?:\s+([^<>\[\]]*))?\s*([>\]])/g;

const MAX_PARAMS = 25;
const MAX_DESC_LEN = 100;

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

    const [, openBracket, rawName, rawDesc = "", closeBracket] = match;
    // Bracket pair must match (no mixing < with ])
    const isRequired = openBracket === "<" && closeBracket === ">";
    const isOptional = openBracket === "[" && closeBracket === "]";
    if (!isRequired && !isOptional) continue;

    const baseName = rawName.toLowerCase();
    const seen = seenNames.get(baseName) ?? 0;
    seenNames.set(baseName, seen + 1);
    const name = seen === 0 ? baseName : `${baseName}_${seen + 1}`;

    const description = truncateDescription(rawDesc.trim() || baseName);

    params.push({
      name,
      description,
      required: isRequired,
      originalIndex: index,
    });
    index++;
  }

  return params;
}
