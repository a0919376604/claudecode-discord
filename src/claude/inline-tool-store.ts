import type { NormalizedEvent } from "../agent/backend.js";
import { L } from "../utils/i18n.js";
import { formatToolActivity } from "./tool-activity.js";

export type ToolStatus = "running" | "completed" | "failed" | "declined" | "stopped" | "unknown";
export interface InlineTool {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  status: ToolStatus;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  output: string;
}
export const clip = (value: string, max: number): string => value.length > max ? value.slice(0, max - 1) + "…" : value;

/** Bounded display data only. Raw reasoning never enters this store. */
export function safeToolText(value: string): string {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|token|password|secret|authorization)["']?\s*[:=]\s*)(?:Bearer[ \t]+)?(?:"[^"]*(?:"|$)|'[^']*(?:'|$)|[^\s,;]+)/gi, "$1[redacted]")
    .replace(/\bBearer[ \t]+[^\s"',;]+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk-[\w-]{6,}|gh[pousr]_[\w]{8,}|github_pat_[\w]+|xox[baprs]-[\w-]+)/g, "[redacted]")
    .replace(/@/g, "@\u200b").replace(/`/g, "′");
}

export class InlineToolStore {
  private items = new Map<string, InlineTool>();
  private rawOutput = new Map<string, string>();
  private seen = new Set<string>();
  private sequence = 0;
  private frozen = false;
  count = 0;

  get(id: string): InlineTool | undefined { return this.items.get(id); }
  get running(): number { return [...this.items.values()].filter(t => t.status === "running").length; }

  observe(event: NormalizedEvent, now = Date.now()): string | undefined {
    if (this.frozen) return;
    if (event.type === "tool_output_delta") {
      const item = this.items.get(event.itemId);
      if (!item) return;
      // Keep enough overlap to redact credentials split across delta boundaries.
      const raw = (this.rawOutput.get(item.id) ?? "") + event.text;
      item.output = safeToolText(raw).slice(-2048);
      this.rawOutput.set(item.id, raw.slice(-8192));
      return item.id;
    }
    if (event.type !== "tool_start" && event.type !== "tool_end") return;
    const input = event.input ?? {};
    const id = typeof input.id === "string" ? input.id
      : event.type === "tool_end"
        ? [...this.items.values()].reverse().find(t => t.status === "running" && t.toolName === event.toolName)?.id ?? `legacy-${++this.sequence}`
        : `legacy-${++this.sequence}`;
    let item = this.items.get(id);
    // Expire detailed inputs/output, but retain lightweight identity for this turn.
    if (!item && this.seen.has(id)) return;
    if (item && item.status !== "running") return id;
    if (!item) {
      item = { id, toolName: event.toolName, input, status: "running", startedAt: now, output: "" };
      this.items.set(id, item);
      this.seen.add(id);
      this.count++;
      // Retain active work; older completed details have a bounded lifetime.
      if (this.items.size > 256) {
        const old = [...this.items.values()].find(t => t.status !== "running");
        if (old) { this.items.delete(old.id); this.rawOutput.delete(old.id); }
      }
    } else item.input = { ...item.input, ...input };
    if (event.type === "tool_end") {
      const status = input.status;
      item.status = status === "declined" ? "declined"
        : status === "interrupted" || status === "stopped" ? "stopped"
        : !event.ok || (typeof input.exitCode === "number" && input.exitCode !== 0) ? "failed" : "completed";
      item.finishedAt = now;
      if (typeof input.durationMs === "number" && input.durationMs >= 0) item.durationMs = input.durationMs;
      if (!item.output && typeof input.aggregatedOutput === "string") item.output = safeToolText(input.aggregatedOutput).slice(-2048);
    }
    return id;
  }

  finalize(stopped: boolean, now = Date.now()): void {
    this.frozen = true;
    for (const item of this.items.values()) if (item.status === "running") {
      item.status = stopped ? "stopped" : "unknown";
      item.finishedAt = now;
    }
    this.rawOutput.clear();
  }

  rows(ids: string[], now = Date.now()): string {
    const statusText: Record<ToolStatus, string> = {
      running: L("Running", "실행 중"), completed: L("Completed", "완료"),
      failed: L("Failed", "실패"), declined: L("Declined", "거절됨"),
      stopped: L("Stopped", "중지됨"), unknown: L("Not confirmed", "완료 미확인"),
    };
    const icons: Record<ToolStatus, string> = { running: "⏳", completed: "✓", failed: "✗", declined: "⊘", stopped: "■", unknown: "?" };
    return ids.flatMap(id => {
      const item = this.items.get(id);
      if (!item) return [];
      const seconds = Math.max(0, (item.durationMs ?? ((item.finishedAt ?? now) - item.startedAt)) / 1000);
      const label = clip(safeToolText(formatToolActivity(item.toolName, item.input)), 160).replace(/\s+/g, " ");
      const tail = item.output.trim().split("\n").filter(Boolean).at(-1);
      return [`${icons[item.status]} ${label}\n${statusText[item.status]} · ${seconds.toFixed(seconds < 1 ? 1 : 0)}s${tail ? `\n${L("Latest output", "최근 출력")}: ${clip(tail, 180)}` : ""}`];
    }).join("\n\n");
  }

  details(): string { return clip(this.rows([...this.items.keys()].slice(-12)), 1800); }
}
