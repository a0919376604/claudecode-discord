import { describe, expect, it } from "vitest";
import { localTimeToUtcCron } from "./schedule.js";

const now = new Date("2026-01-15T12:00:00Z");
describe("localTimeToUtcCron", () => {
  it.each([
    ["08:00", "Asia/Taipei", undefined, "0 0 * * *"],
    ["07:00", "Asia/Taipei", undefined, "0 23 * * *"],
    ["07:00", "Asia/Taipei", 0, "0 23 * * 6"],
    ["08:30", "UTC", 0, "30 8 * * 0"],
    ["23:30", "America/New_York", 6, "30 4 * * 0"],
    ["08:00", "Asia/Kolkata", undefined, "30 2 * * *"],
  ])("%s in %s (day %s) → %s", (time, zone, day, expected) => {
    expect(localTimeToUtcCron(time, zone, day, now)).toBe(expected);
  });
  it.each(["25:00", "12:60", "8:00", "wrong"])("rejects invalid time %s", time => {
    expect(() => localTimeToUtcCron(time, "UTC", undefined, now)).toThrow("invalid time");
  });
  it("rejects invalid timezone", () => {
    expect(() => localTimeToUtcCron("08:00", "Mars/Base", undefined, now)).toThrow("invalid timezone");
  });
});
