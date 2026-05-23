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
