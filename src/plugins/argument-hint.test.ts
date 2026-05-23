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
