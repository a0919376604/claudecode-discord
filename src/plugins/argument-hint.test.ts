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
      { name: "topic", description: "topic", required: false, originalIndex: 0 },
    ]);
  });

  it("parses <topic> as one required param", () => {
    expect(parseArgumentHint("<topic>")).toEqual([
      { name: "topic", description: "topic", required: true, originalIndex: 0 },
    ]);
  });

  it("ignores leading/trailing whitespace around a single slot", () => {
    expect(parseArgumentHint("  [file]  ")).toEqual([
      { name: "file", description: "file", required: false, originalIndex: 0 },
    ]);
  });
});

describe("parseArgumentHint — multiple slots", () => {
  it("parses '<file> [range]' as required then optional", () => {
    expect(parseArgumentHint("<file> [range]")).toEqual([
      { name: "file", description: "file", required: true, originalIndex: 0 },
      { name: "range", description: "range", required: false, originalIndex: 1 },
    ]);
  });

  it("parses inline descriptions inside the same bracket pair", () => {
    expect(parseArgumentHint("[topic the research topic]")).toEqual([
      { name: "topic", description: "the research topic", required: false, originalIndex: 0 },
    ]);
  });

  it("preserves original index even when required appears after optional", () => {
    expect(parseArgumentHint("[range] <file>")).toEqual([
      { name: "range", description: "range", required: false, originalIndex: 0 },
      { name: "file", description: "file", required: true, originalIndex: 1 },
    ]);
  });

  it("handles three mixed slots", () => {
    expect(parseArgumentHint("<a> [b banana] <c>")).toEqual([
      { name: "a", description: "a", required: true, originalIndex: 0 },
      { name: "b", description: "banana", required: false, originalIndex: 1 },
      { name: "c", description: "c", required: true, originalIndex: 2 },
    ]);
  });
});

describe("parseArgumentHint — sanitization", () => {
  it("lowercases param names", () => {
    expect(parseArgumentHint("[Topic]")).toEqual([
      { name: "topic", description: "topic", required: false, originalIndex: 0 },
    ]);
  });

  it("suffixes duplicate names with _2, _3", () => {
    expect(parseArgumentHint("[name] [name] [name]")).toEqual([
      { name: "name", description: "name", required: false, originalIndex: 0 },
      { name: "name_2", description: "name", required: false, originalIndex: 1 },
      { name: "name_3", description: "name", required: false, originalIndex: 2 },
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
      { name: "file", description: "file", required: false, originalIndex: 0 },
    ]);
  });

  it("ignores slots with mismatched brackets ([name>)", () => {
    expect(parseArgumentHint("[name>")).toEqual([]);
  });

  it("ignores slots starting with a digit", () => {
    expect(parseArgumentHint("[1foo]")).toEqual([]);
  });
});
