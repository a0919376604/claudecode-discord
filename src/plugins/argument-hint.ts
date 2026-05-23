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
// Captures: open bracket, name token, optional description text, close bracket.
const SLOT_RE = /([<\[])\s*([A-Za-z][A-Za-z0-9_-]*)(?:\s+([^>\]]*))?\s*([>\]])/g;

export function parseArgumentHint(hint: string): ParsedParam[] {
  if (!hint || !hint.trim()) return [];

  const params: ParsedParam[] = [];
  let match: RegExpExecArray | null;
  let index = 0;

  SLOT_RE.lastIndex = 0;
  while ((match = SLOT_RE.exec(hint)) !== null) {
    const [, openBracket, rawName, rawDesc = "", closeBracket] = match;
    // Bracket pair must match (no mixing < with ])
    const isRequired = openBracket === "<" && closeBracket === ">";
    const isOptional = openBracket === "[" && closeBracket === "]";
    if (!isRequired && !isOptional) continue;

    const name = rawName.toLowerCase();
    const description = rawDesc.trim() || name;

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
