import { describe, it, expect, vi } from "vitest";

vi.mock("../utils/i18n.js", () => ({ L: (en: string) => en }));

import { TaskBoard, renderBoard, formatTaskDetail, MAX_BOARD_ROWS } from "./task-board.js";

const T0 = 1_791_800_000_000;

/** Flatten every text_display content and button in render order. */
function flatten(json: unknown): { texts: string[]; buttons: { label?: string; custom_id?: string; url?: string }[]; count: number } {
  const texts: string[] = [];
  const buttons: { label?: string; custom_id?: string; url?: string }[] = [];
  let count = 0;
  const walk = (c: Record<string, unknown>) => {
    count++;
    if (c.type === 10) texts.push(c.content as string); // TextDisplay
    if (c.type === 2) buttons.push(c as { label?: string; custom_id?: string; url?: string }); // Button
    for (const child of (c.components as Record<string, unknown>[] | undefined) ?? []) walk(child);
    if (c.accessory) walk(c.accessory as Record<string, unknown>);
  };
  walk(json as Record<string, unknown>);
  return { texts, buttons, count };
}

function boardWith(n: { running?: number; done?: number }): TaskBoard {
  const b = new TaskBoard("123456789012345678", T0);
  const live = [];
  for (let i = 0; i < (n.running ?? 0) + (n.done ?? 0); i++) live.push({ id: `t${i}`, description: `task ${i}`, taskType: "local_agent" });
  b.syncLive(live, T0);
  for (let i = 0; i < (n.done ?? 0); i++) b.done(`t${(n.running ?? 0) + i}`, { status: "completed", summary: `result ${i}` }, T0 + 60_000);
  return b;
}

describe("TaskBoard state", () => {
  it("tracks a task from live → progress → done", () => {
    const b = new TaskBoard("c", T0);
    b.syncLive([{ id: "a", description: "Event table write path", taskType: "local_agent" }], T0);
    b.progress("a", { summary: "Comparing three call sites", toolUses: 14 });
    expect(b.get("a")).toMatchObject({ status: "running", progress: "Comparing three call sites", toolUses: 14 });
    b.done("a", { status: "completed", summary: "Writes go through EventRepo.insert", toolUses: 18, durationMs: 102_000 }, T0 + 102_000);
    expect(b.get("a")).toMatchObject({ status: "completed", summary: "Writes go through EventRepo.insert", toolUses: 18 });
  });

  it("ignores progress/done for tasks it never saw live (e.g. an agent's own inner Bash)", () => {
    const b = new TaskBoard("c", T0);
    b.progress("inner", { lastTool: "Bash" });
    b.done("inner", { status: "completed" }, T0);
    expect(b.size).toBe(0);
  });

  it("finalize() marks still-running tasks stopped", () => {
    const b = boardWith({ running: 1 });
    b.finalize(T0 + 5_000);
    expect(b.get("t0")?.status).toBe("stopped");
  });
});

describe("renderBoard", () => {
  it("orders groups needs-you → running → finished and shows the blocking reason", () => {
    const b = boardWith({ running: 1, done: 1 });
    b.setNeedsYou("q1", "Waiting for your answer: kmeans or HDBSCAN?", "https://discord.com/channels/1/2/3");
    const { texts, buttons } = flatten(renderBoard(b, { now: T0 + 90_000, toolUseCount: 9, phase: "running", showStop: true }).toJSON());
    const joined = texts.join("\n");
    expect(joined.indexOf("Needs you")).toBeLessThan(joined.indexOf("Running"));
    expect(joined.indexOf("Running")).toBeLessThan(joined.indexOf("Finished"));
    expect(joined).toContain("Waiting for your answer: kmeans or HDBSCAN?");
    expect(buttons.some((x) => x.url === "https://discord.com/channels/1/2/3")).toBe(true);
    expect(buttons.some((x) => x.custom_id === "stop:123456789012345678")).toBe(true);
  });

  it("shows the progress summary, falling back to the last tool", () => {
    const b = boardWith({ running: 2 });
    b.progress("t0", { summary: "Listing /tmp entries" });
    b.progress("t1", { lastTool: "Grep" });
    const { texts } = flatten(renderBoard(b, { now: T0, toolUseCount: 0, phase: "running", showStop: true }).toJSON());
    const joined = texts.join("\n");
    expect(joined).toContain("Listing /tmp entries");
    expect(joined).toContain("Grep");
  });

  it("distinguishes failed, stopped and interrupted, with the error line", () => {
    const b = boardWith({ running: 3 });
    b.done("t0", { status: "failed", error: "vite build exited 1\nmore detail" }, T0 + 1000);
    b.done("t1", { status: "stopped" }, T0 + 1000);
    b.done("t2", { status: "interrupted" }, T0 + 1000);
    const joined = flatten(renderBoard(b, { now: T0, toolUseCount: 0, phase: "running", showStop: true }).toJSON()).texts.join("\n");
    expect(joined).toContain("❌");
    expect(joined).toContain("vite build exited 1");
    expect(joined).not.toContain("more detail");
    expect(joined).toContain("⏹️");
    expect(joined).toContain("⚠️");
  });

  it("gives finished tasks with a summary a 📄 button routed to task-out", () => {
    const b = boardWith({ done: 1 });
    const { buttons } = flatten(renderBoard(b, { now: T0, toolUseCount: 0, phase: "done", showStop: false }).toJSON());
    expect(buttons.map((x) => x.custom_id)).toContain("task-out:123456789012345678:t0");
    expect(buttons.some((x) => x.custom_id?.startsWith("stop:"))).toBe(false);
  });

  it("stays within Discord's 40-component limit and folds extra finished rows", () => {
    const b = boardWith({ running: 2, done: 30 });
    const { texts, count } = flatten(renderBoard(b, { now: T0, toolUseCount: 0, phase: "running", showStop: true }).toJSON());
    expect(count).toBeLessThanOrEqual(40);
    const shownRows = texts.filter((t) => /task \d+/.test(t)).length;
    expect(shownRows).toBe(MAX_BOARD_ROWS);
    expect(texts.join("\n")).toContain(`+${32 - MAX_BOARD_ROWS} more finished`);
  });
});

describe("formatTaskDetail", () => {
  it("includes summary, error and the output tail, within 2000 chars", () => {
    const b = boardWith({ running: 1 });
    b.done("t0", { status: "failed", summary: "S".repeat(1500), error: "boom" }, T0 + 5_000);
    const out = formatTaskDetail(b.get("t0")!, "line\n".repeat(2000) + "LAST LINE");
    expect(out.length).toBeLessThanOrEqual(2000);
    expect(out).toContain("boom");
    expect(out).toContain("LAST LINE");
    expect(out.match(/```/g)).toHaveLength(2); // fence opened and closed
  });
});
