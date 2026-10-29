import { describe, it, expect, vi } from "vitest";
import { CodexTaskCard } from "./codex-task-card.js";

describe("Codex task card", () => {
  it("counts every reported step even when the detail list is shortened", async () => {
    const card = new CodexTaskCard("run", "Task");
    card.observe({ type: "plan_update", steps: [
      ...Array.from({ length: 30 }, (_, i) => ({ step: `Step ${i}`, status: "completed" as const })),
      { step: "Remaining work", status: "inProgress" },
    ] });
    expect(JSON.stringify(card.render())).toContain("30/31");
    expect(JSON.stringify(card.render())).toContain("Remaining work");
    await card.finish("done");
  });
  it("shows only observed model and plan, with copyable answers outside the card", () => {
    const card = new CodexTaskCard("run-1", "Add model settings", 1000);
    expect(JSON.stringify(card.render(2000))).not.toMatch(/gpt-|%|1\/3/);
    card.observe({ type: "session_init", sessionId: "thread", model: "gpt-6.1-sol" });
    card.observe({ type: "plan_update", steps: [{ step: "Inspect", status: "completed" }, { step: "Build", status: "inProgress" }] });
    card.observe({ type: "text_delta", text: "private reasoning", isReasoning: true });
    const rendered = JSON.stringify(card.render(3000));
    expect(rendered).toContain("gpt-6.1-sol");
    expect(rendered).toContain("1/2");
    expect(rendered).not.toContain("private reasoning");
  });

  it("keeps terminal state after delayed events and bounds Discord payloads", async () => {
    const card = new CodexTaskCard("run-1", "X".repeat(4000));
    const edit = vi.fn(async () => {});
    card.attach({ edit, url: "https://discord.com/channels/g/c/m" } as never);
    card.observe({ type: "tool_start", toolName: "Bash", input: { command: "a".repeat(5000) } });
    card.requestStop();
    expect(card.phase).toBe("stopping");
    await card.finish("stopped", "Stopped safely");
    card.observe({ type: "tool_start", toolName: "Bash", input: { command: "late" } });
    await card.finish("done", "incorrect late result");
    expect(card.phase).toBe("stopped");
    const payload = card.render();
    const embed = payload.embeds[0].toJSON();
    expect(embed.title!.length).toBeLessThanOrEqual(256);
    expect(JSON.stringify(payload).length).toBeLessThan(6000);
    expect(card.details().length).toBeLessThanOrEqual(2000);
    expect(JSON.stringify(payload)).not.toContain("incorrect late result");
    expect(edit).toHaveBeenCalled();
  });

  it("clears one approval without losing another and serializes card edits", async () => {
    const card = new CodexTaskCard("run", "Test");
    let concurrent = 0;
    let peak = 0;
    card.attach({ edit: async () => { peak = Math.max(peak, ++concurrent); await Promise.resolve(); --concurrent; } } as never);
    card.need("a", "Approve write", "https://discord.com/a");
    card.need("b", "Approve command", "https://discord.com/b");
    card.clearNeed("a");
    expect(card.phase).toBe("waiting");
    await Promise.all([card.flush(), card.flush(), card.finish("failed", "Connection lost")]);
    expect(peak).toBe(1);
    expect(card.phase).toBe("failed");
    expect(JSON.stringify(card.render())).toContain("card-recover:run");
  });
});
