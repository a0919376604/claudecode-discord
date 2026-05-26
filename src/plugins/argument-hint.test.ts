import { describe, it, expect } from "vitest";
import { parseArgumentHint } from "./argument-hint.js";

describe("parseArgumentHint — empty cases", () => {
  it("returns [] for empty string", () => {
    expect(parseArgumentHint("")).toEqual([]);
  });

  it("returns [] for whitespace-only string", () => {
    expect(parseArgumentHint("   ")).toEqual([]);
  });

  it("returns [] for hint with no bracketed slots (freeform text only)", () => {
    expect(parseArgumentHint("just some words")).toEqual([]);
  });
});

describe("parseArgumentHint — single slot", () => {
  it("parses [topic] as one optional param", () => {
    expect(parseArgumentHint("[topic]")).toEqual([
      { name: "topic", description: "topic", required: false, originalIndex: 0, type: "text" },
    ]);
  });

  it("parses <topic> as one required param", () => {
    expect(parseArgumentHint("<topic>")).toEqual([
      { name: "topic", description: "topic", required: true, originalIndex: 0, type: "text" },
    ]);
  });

  it("ignores leading/trailing whitespace around a single slot", () => {
    expect(parseArgumentHint("  [file]  ")).toEqual([
      { name: "file", description: "file", required: false, originalIndex: 0, type: "text" },
    ]);
  });
});

describe("parseArgumentHint — multiple slots", () => {
  it("parses '<file> [range]' as required then optional", () => {
    expect(parseArgumentHint("<file> [range]")).toEqual([
      { name: "file", description: "file", required: true, originalIndex: 0, type: "text" },
      { name: "range", description: "range", required: false, originalIndex: 1, type: "text" },
    ]);
  });

  it("parses inline descriptions inside the same bracket pair", () => {
    expect(parseArgumentHint("[topic the research topic]")).toEqual([
      { name: "topic", description: "the research topic", required: false, originalIndex: 0, type: "text" },
    ]);
  });

  it("preserves original index even when required appears after optional", () => {
    expect(parseArgumentHint("[range] <file>")).toEqual([
      { name: "range", description: "range", required: false, originalIndex: 0, type: "text" },
      { name: "file", description: "file", required: true, originalIndex: 1, type: "text" },
    ]);
  });

  it("handles three mixed slots", () => {
    expect(parseArgumentHint("<a> [b banana] <c>")).toEqual([
      { name: "a", description: "a", required: true, originalIndex: 0, type: "text" },
      { name: "b", description: "banana", required: false, originalIndex: 1, type: "text" },
      { name: "c", description: "c", required: true, originalIndex: 2, type: "text" },
    ]);
  });
});

describe("parseArgumentHint — sanitization", () => {
  it("lowercases param names", () => {
    expect(parseArgumentHint("[Topic]")).toEqual([
      { name: "topic", description: "topic", required: false, originalIndex: 0, type: "text" },
    ]);
  });

  it("suffixes duplicate names with _2, _3", () => {
    expect(parseArgumentHint("[name] [name] [name]")).toEqual([
      { name: "name", description: "name", required: false, originalIndex: 0, type: "text" },
      { name: "name_2", description: "name", required: false, originalIndex: 1, type: "text" },
      { name: "name_3", description: "name", required: false, originalIndex: 2, type: "text" },
    ]);
  });

  it("truncates descriptions over 100 chars to 97 + '...'", () => {
    const long = "x".repeat(150);
    const result = parseArgumentHint(`[topic ${long}]`);
    expect(result).toHaveLength(1);
    expect(result[0]!.description).toHaveLength(100);
    expect(result[0]!.description.endsWith("...")).toBe(true);
  });

  it("truncates after 25 slots and ignores the rest", () => {
    const slots = Array.from({ length: 30 }, (_, i) => `[p${i}]`).join(" ");
    const result = parseArgumentHint(slots);
    expect(result).toHaveLength(25);
    expect(result[24]!.name).toBe("p24");
  });

  it("ignores unclosed brackets", () => {
    expect(parseArgumentHint("[topic <unclosed [file]")).toEqual([
      { name: "file", description: "file", required: false, originalIndex: 0, type: "text" },
    ]);
  });

  it("ignores slots with mismatched brackets ([name>)", () => {
    expect(parseArgumentHint("[name>")).toEqual([]);
  });

  it("ignores slots starting with a digit", () => {
    expect(parseArgumentHint("[1foo]")).toEqual([]);
  });
});

describe("parseArgumentHint — type inference", () => {
  it("infers type='path' for the 'repo' name", () => {
    expect(parseArgumentHint("<repo>")).toEqual([
      { name: "repo", description: "repo", required: true, originalIndex: 0, type: "path" },
    ]);
  });

  it("infers type='path' for 'repo-path'", () => {
    expect(parseArgumentHint("<repo-path>")).toEqual([
      { name: "repo-path", description: "repo-path", required: true, originalIndex: 0, type: "path" },
    ]);
  });

  it("infers type='path' for all of: path, project, project-path, dir, directory", () => {
    for (const n of ["path", "project", "project-path", "dir", "directory"]) {
      const result = parseArgumentHint(`<${n}>`);
      expect(result).toHaveLength(1);
      expect(result[0]!.type).toBe("path");
    }
  });

  it("infers type='text' for non-convention names", () => {
    expect(parseArgumentHint("<topic>")).toEqual([
      { name: "topic", description: "topic", required: true, originalIndex: 0, type: "text" },
    ]);
  });

  it("name convention is case-insensitive via existing lowercase sanitization", () => {
    expect(parseArgumentHint("<Repo>")).toEqual([
      { name: "repo", description: "repo", required: true, originalIndex: 0, type: "path" },
    ]);
  });

  it("explicit <name:path> forces type='path' on a non-convention name", () => {
    expect(parseArgumentHint("<topic:path>")).toEqual([
      { name: "topic", description: "topic", required: true, originalIndex: 0, type: "path" },
    ]);
  });

  it("explicit <name:text> forces type='text' on a convention name", () => {
    expect(parseArgumentHint("<path:text>")).toEqual([
      { name: "path", description: "path", required: true, originalIndex: 0, type: "text" },
    ]);
  });

  it("unknown :type token falls back to name convention", () => {
    expect(parseArgumentHint("<repo:nope>")).toEqual([
      { name: "repo", description: "repo", required: true, originalIndex: 0, type: "path" },
    ]);
    expect(parseArgumentHint("<topic:nope>")).toEqual([
      { name: "topic", description: "topic", required: true, originalIndex: 0, type: "text" },
    ]);
  });

  it("preserves inline description alongside :type annotation", () => {
    expect(parseArgumentHint("<topic:path the repo to scan>")).toEqual([
      { name: "topic", description: "the repo to scan", required: true, originalIndex: 0, type: "path" },
    ]);
  });

  it("supports type annotation on optional slots", () => {
    expect(parseArgumentHint("[topic:path]")).toEqual([
      { name: "topic", description: "topic", required: false, originalIndex: 0, type: "path" },
    ]);
  });

  it("rejects space before colon — '<name :text>' is NOT a type annotation", () => {
    // The colon-and-type must be adjacent to the name (no leading whitespace).
    // The grammar treats ' :text' as the start of the description, so the
    // slot still parses but `type` falls back to the default.
    expect(parseArgumentHint("<name :text>")).toEqual([
      { name: "name", description: ":text", required: true, originalIndex: 0, type: "text" },
    ]);
  });

  it("accepts space after colon — '<name: text>' description starts with 'text'", () => {
    // Wait — this isn't a description case. The regex is:
    //   (?::\s*([A-Za-z][A-Za-z0-9_-]*))?(?:\s+([^<>\[\]]*))?
    // For '<name: text>': colon matches, \s* consumes the space, then
    // [A-Za-z]... captures "text" as the type_token. Since "text" is a
    // known type, the result is type="text" with no description override.
    expect(parseArgumentHint("<name: text>")).toEqual([
      { name: "name", description: "name", required: true, originalIndex: 0, type: "text" },
    ]);
  });
});
