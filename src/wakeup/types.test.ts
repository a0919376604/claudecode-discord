import { describe, it, expect } from "vitest";
import { WakeupPayloadSchema, deriveDedupeKey, isExpired } from "./types.js";

const validPayload = {
  channel_id: "123456789012345678",
  prompt: "/run-plan status refactor-foo",
  source: "run-plan",
  metadata: { slot: "refactor-foo", status: "DONE", commits: "+7" },
  created_at: "2026-06-01T12:00:00Z",
};

describe("WakeupPayloadSchema", () => {
  it("accepts a valid payload", () => {
    const result = WakeupPayloadSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
  });

  it("rejects non-snowflake channel_id", () => {
    const bad = { ...validPayload, channel_id: "not-a-snowflake" };
    expect(WakeupPayloadSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects channel_id shorter than 17 digits", () => {
    const bad = { ...validPayload, channel_id: "1234567890" };
    expect(WakeupPayloadSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects channel_id longer than 20 digits", () => {
    const bad = { ...validPayload, channel_id: "1".repeat(21) };
    expect(WakeupPayloadSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects prompt longer than 4000 chars", () => {
    const bad = { ...validPayload, prompt: "x".repeat(4001) };
    expect(WakeupPayloadSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects source with disallowed chars", () => {
    const bad = { ...validPayload, source: "run plan!" };
    expect(WakeupPayloadSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects source longer than 64 chars", () => {
    const bad = { ...validPayload, source: "a".repeat(65) };
    expect(WakeupPayloadSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects non-ISO created_at", () => {
    const bad = { ...validPayload, created_at: "yesterday" };
    expect(WakeupPayloadSchema.safeParse(bad).success).toBe(false);
  });

  it("treats metadata as optional", () => {
    const { metadata, ...rest } = validPayload;
    expect(metadata).toBeDefined(); // touch to silence unused-var
    expect(WakeupPayloadSchema.safeParse(rest).success).toBe(true);
  });

  it("treats ttl_seconds as optional", () => {
    const result = WakeupPayloadSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
    // default applies when missing
    if (result.success) expect(result.data.ttl_seconds).toBe(86400);
  });
});

describe("deriveDedupeKey", () => {
  it("uses metadata.slot when present", () => {
    expect(deriveDedupeKey("run-plan", { slot: "foo" })).toBe("run-plan:foo");
  });

  it("hashes metadata when slot missing", () => {
    const a = deriveDedupeKey("ci", { branch: "main", build: 42 });
    const b = deriveDedupeKey("ci", { build: 42, branch: "main" });
    expect(a).toBe(b); // canonical (key-sorted)
    expect(a.startsWith("ci:")).toBe(true);
    expect(a.length).toBeGreaterThan(3);
  });

  it("falls back to created_at when metadata empty", () => {
    expect(deriveDedupeKey("misc", undefined, "2026-06-01T12:00:00Z"))
      .toBe("misc:2026-06-01T12:00:00Z");
  });
});

describe("isExpired", () => {
  it("returns false for fresh payloads", () => {
    const created = new Date(Date.now() - 60_000).toISOString();
    expect(isExpired({ created_at: created, ttl_seconds: 86400 })).toBe(false);
  });

  it("returns true when ttl exceeded", () => {
    const created = new Date(Date.now() - 90_000).toISOString();
    expect(isExpired({ created_at: created, ttl_seconds: 60 })).toBe(true);
  });

  it("returns true when created_at is unparseable", () => {
    expect(isExpired({ created_at: "garbage", ttl_seconds: 86400 })).toBe(true);
  });
});
