import { describe, expect, it, vi } from "vitest";
vi.mock("../utils/i18n.js", () => ({ L: (en: string) => en }));
import { formatToolActivity } from "./tool-activity.js";

describe("formatToolActivity", () => {
  it.each([
    ["Bash", { command: "npm test" }, "Running command `npm test`"],
    ["Write", { changes: [{ path: "/project/src/a.ts" }, { path: "C:\\project\\b.ts" }] }, "Writing file `a.ts, b.ts`"],
    ["MCP", { server: "docs", tool: "search", arguments: { token: "private" } }, "Using MCP `docs/search`"],
    ["WebSearch", { query: "Codex docs" }, "Searching web `Codex docs`"],
    ["Read", { file_path: "/src/config.ts" }, "Reading files `config.ts`"],
    ["Bash", { command: "cat a.ts", commandActions: [{ type: "read", path: "/src/a.ts" }] }, "Reading files `a.ts`"],
  ])("describes %s activity", (name, input, expected) => {
    expect(formatToolActivity(name as string, input as Record<string, unknown>)).toBe(expected);
  });

  it("keeps long multiline commands on one bounded line", () => {
    const activity = formatToolActivity("Bash", { command: "echo `hello`\n" + "x".repeat(500) });
    expect(activity).not.toContain("\n");
    expect(activity.length).toBeLessThan(180);
    expect(activity).not.toContain("`hello`");
  });

  it.each([[true, "✅ Bash `npm test`"], [false, "❌ Bash `npm test`"]])("shows a completed tool outcome %s", (ok, expected) => {
    expect(formatToolActivity("Bash", { command: "npm test" }, ok as boolean)).toBe(expected);
  });
});
