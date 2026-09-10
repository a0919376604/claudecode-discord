import { describe, it, expect } from "vitest";
import { unwrapErrorMessage } from "./error-format.js";

describe("unwrapErrorMessage", () => {
  it("returns plain Error.message when no aggregate", () => {
    expect(unwrapErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("unwraps AggregateError-style .errors[]", () => {
    const aggr = Object.assign(new Error("Received one or more errors"), {
      errors: [new Error("field.name too long"), new Error("component invalid")],
    });
    const out = unwrapErrorMessage(aggr);
    expect(out).toContain("field.name too long");
    expect(out).toContain("component invalid");
    expect(out).toContain("Received one or more errors");
  });

  it("bounds sub-error count with '+N more' suffix", () => {
    const many = Array.from({ length: 12 }, (_, i) => new Error(`e${i}`));
    const aggr = Object.assign(new Error("Received one or more errors"), { errors: many });
    const out = unwrapErrorMessage(aggr);
    expect(out).toContain("+4 more");
    // Only first 8 shown
    expect(out).toContain("e0");
    expect(out).toContain("e7");
    expect(out).not.toContain("e8");
  });

  it("bounds recursion depth", () => {
    // Build a 5-level deep nested aggregate — should truncate at "…"
    let nested: unknown = new Error("leaf");
    for (let i = 0; i < 5; i++) {
      nested = Object.assign(new Error(`level${i}`), { errors: [nested] });
    }
    const out = unwrapErrorMessage(nested);
    expect(out).toContain("…");
  });

  it("handles non-Error values", () => {
    expect(unwrapErrorMessage("plain string")).toBe("plain string");
    expect(unwrapErrorMessage(null)).toBe("Unknown error");
    expect(unwrapErrorMessage(undefined)).toBe("Unknown error");
    expect(unwrapErrorMessage({ toString: () => "custom" })).toBe("custom");
  });

  it("handles Error with empty message by falling back to class name", () => {
    class SpecificError extends Error {}
    const e = new SpecificError("");
    expect(unwrapErrorMessage(e)).toBe("SpecificError");
  });
});
