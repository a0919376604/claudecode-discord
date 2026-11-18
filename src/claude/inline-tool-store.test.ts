import { describe, expect, it, vi } from "vitest";
vi.mock("../utils/i18n.js", () => ({ L: (en: string) => en }));
import { InlineToolStore, safeToolText } from "./inline-tool-store.js";

describe("inline tool lifecycle", () => {
  it("redacts bearer headers and quoted JSON credential fields", () => {
    const output = safeToolText('Authorization: Bearer example-access-value\n{"token":"example-json-value","api_key":"example-key-value"}');
    expect(output).not.toContain("example-access-value");
    expect(output).not.toContain("example-json-value");
    expect(output).not.toContain("example-key-value");
    const store = new InlineToolStore();
    store.observe({ type: "tool_start", toolName: "Bash", input: { id: "auth" } });
    store.observe({ type: "tool_output_delta", itemId: "auth", text: 'Authorization: Bearer example-' });
    store.observe({ type: "tool_output_delta", itemId: "auth", text: 'access-value\n{"api_key":"example-' });
    store.observe({ type: "tool_output_delta", itemId: "auth", text: 'key-value"}' });
    expect(store.get("auth")?.output).not.toMatch(/example-|access-value|key-value/);
  });
  it("pairs concurrent tools by id, retains fast completions, and deduplicates starts", () => {
    const store = new InlineToolStore();
    store.observe({ type: "tool_start", toolName: "Bash", input: { id: "a", command: "read a" } }, 0);
    store.observe({ type: "tool_start", toolName: "Bash", input: { id: "b", command: "read b" } }, 10);
    store.observe({ type: "tool_start", toolName: "Bash", input: { id: "a", command: "read a" } }, 20);
    store.observe({ type: "tool_end", toolName: "Bash", input: { id: "b" }, ok: true }, 100);
    expect(store.count).toBe(2);
    expect(store.get("a")?.status).toBe("running");
    expect(store.get("b")?.status).toBe("completed");
    expect(store.rows(["a", "b"], 200)).toContain("read b");
  });
  it("bounds output after sanitizing split credentials and terminal escape sequences", () => {
    const store = new InlineToolStore();
    store.observe({ type: "tool_start", toolName: "Bash", input: { id: "a", command: "npm test" } });
    store.observe({ type: "tool_output_delta", itemId: "a", text: "\u001b[31mTOKEN=sk-private" });
    store.observe({ type: "tool_output_delta", itemId: "a", text: "-secret-value\n" + "x".repeat(3000) + "\n8 passed @everyone ```" });
    const output = store.get("a")!.output;
    expect(output.length).toBeLessThanOrEqual(2048);
    expect(output).not.toContain("secret-value");
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("@everyone");
    expect(output).not.toContain("```");
    expect(output).toContain("8 passed");
  });
  it("preserves completed work when stopped and cannot be revived by late completion", () => {
    const store = new InlineToolStore();
    store.observe({ type: "tool_start", toolName: "Read", input: { id: "read", file_path: "C:\\repo\\file.ts" } });
    store.observe({ type: "tool_end", toolName: "Read", input: { id: "read" }, ok: true });
    store.observe({ type: "tool_start", toolName: "Bash", input: { id: "test", command: "npm test" } });
    store.finalize(true);
    store.observe({ type: "tool_end", toolName: "Bash", input: { id: "test" }, ok: true });
    expect(store.get("read")?.status).toBe("completed");
    expect(store.get("test")?.status).toBe("stopped");
    expect(store.details()).toContain("file.ts");
  });
  it("does not recount a duplicate completion after detailed records expire", () => {
    const store = new InlineToolStore();
    for(let i=0;i<257;i++) store.observe({type:"tool_end",toolName:"Bash",input:{id:`tool-${i}`},ok:true});
    store.observe({type:"tool_end",toolName:"Bash",input:{id:"tool-0"},ok:true});
    expect(store.count).toBe(257);
  });
  it("distinguishes decline, nonzero exit, and an unconfirmed end", () => {
    const store = new InlineToolStore();
    store.observe({ type: "tool_end", toolName: "Bash", input: { id: "deny", status: "declined" }, ok: false });
    store.observe({ type: "tool_end", toolName: "Bash", input: { id: "fail", exitCode: 1 }, ok: true });
    store.observe({ type: "tool_start", toolName: "Bash", input: { id: "unknown" } });
    store.finalize(false);
    expect(store.get("deny")?.status).toBe("declined");
    expect(store.get("fail")?.status).toBe("failed");
    expect(store.get("unknown")?.status).toBe("unknown");
  });
});
