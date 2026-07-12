import { describe, it, expect } from "vitest";
import { validateCronExpr, nextFireAfter } from "./parser.js";

describe("validateCronExpr", () => {
  it("accepts standard 5-field cron", () => {
    expect(validateCronExpr("0 9 * * *")).toEqual({ valid: true });
    expect(validateCronExpr("*/5 * * * *")).toEqual({ valid: true });
  });
  it("rejects garbage", () => {
    const result = validateCronExpr("not a cron");
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toMatch(/parse|invalid/i);
  });
  it("rejects empty string", () => {
    expect(validateCronExpr("").valid).toBe(false);
  });
});

describe("nextFireAfter", () => {
  it("computes next daily fire in the future", () => {
    // 2026-07-13T00:00:00Z is a Monday
    const from = Date.UTC(2026, 6, 13, 0, 0, 0);
    // "0 9 * * *" fires at 9:00 UTC every day
    const next = nextFireAfter("0 9 * * *", from);
    expect(next).toBe(Date.UTC(2026, 6, 13, 9, 0, 0));
  });
  it("skips past to next valid slot when current slot already passed", () => {
    const from = Date.UTC(2026, 6, 13, 10, 0, 0); // 10:00 UTC
    const next = nextFireAfter("0 9 * * *", from);
    expect(next).toBe(Date.UTC(2026, 6, 14, 9, 0, 0)); // next day's 9:00
  });
  it("throws on invalid expr", () => {
    expect(() => nextFireAfter("garbage", Date.now())).toThrow();
  });
});
