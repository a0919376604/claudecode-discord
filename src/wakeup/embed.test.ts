import { describe, it, expect } from "vitest";
import { buildPassiveEmbed } from "./embed.js";
import type { WakeupPayload } from "./types.js";

const runPlanPayload: WakeupPayload = {
  channel_id: "123456789012345678",
  prompt: "/run-plan status refactor-foo",
  source: "run-plan",
  metadata: { slot: "refactor-foo", status: "DONE", commits: "+7" },
  created_at: "2026-06-01T12:00:00Z",
  ttl_seconds: 86400,
};

describe("buildPassiveEmbed", () => {
  it("uses run-plan template when source is run-plan", () => {
    const embed = buildPassiveEmbed(runPlanPayload, { activeSession: false });
    const data = embed.toJSON();
    expect(data.title).toContain("run-plan");
    expect(data.title).toContain("refactor-foo");
    const blob = JSON.stringify(data);
    expect(blob).toContain("DONE");
    expect(blob).toContain("+7");
  });

  it("includes 'after current session' note when active", () => {
    const embed = buildPassiveEmbed(runPlanPayload, { activeSession: true });
    const blob = JSON.stringify(embed.toJSON());
    // Match either English or Korean copy
    expect(blob).toMatch(/current|진행/);
  });

  it("falls back to generic template for unknown source", () => {
    const generic = { ...runPlanPayload, source: "ci", metadata: { build: 42, branch: "main" } };
    const embed = buildPassiveEmbed(generic, { activeSession: false });
    const data = embed.toJSON();
    expect(data.title).toContain("ci");
    const blob = JSON.stringify(data);
    expect(blob).toContain("build");
    expect(blob).toContain("42");
  });

  it("handles missing metadata gracefully", () => {
    const noMeta = { ...runPlanPayload, source: "misc", metadata: undefined };
    const embed = buildPassiveEmbed(noMeta, { activeSession: false });
    expect(() => embed.toJSON()).not.toThrow();
  });
});
