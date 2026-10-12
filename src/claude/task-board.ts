import {
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  SectionBuilder,
  SeparatorBuilder,
  TextDisplayBuilder,
  ActionRowBuilder,
} from "discord.js";
import { L } from "../utils/i18n.js";
import { formatElapsed } from "./progress-decision.js";

/**
 * Background-task board (proposal "B+", 2026-10-12): one Components V2
 * message per session that lists the session's background tasks grouped
 * needs-you → running → finished, with a one-line progress summary per
 * running task and a 📄 button on finished ones.
 *
 * State here is pure and renderable without Discord; session-manager owns
 * the message lifecycle. Only tasks that appeared in the SDK's live set
 * (background_tasks_changed) are tracked — an agent's own inner Bash calls
 * also emit task_* events but are not the user's tasks.
 */

export type TaskStatus = "running" | "completed" | "failed" | "stopped" | "interrupted";

export interface BoardTask {
  id: string;
  description: string;
  taskType: string;
  status: TaskStatus;
  startedAt: number;
  endedAt?: number;
  toolUses?: number;
  lastTool?: string;
  progress?: string;
  summary?: string;
  error?: string;
  outputFile?: string;
}

export interface LiveTask {
  id: string;
  description: string;
  taskType: string;
}

export interface TaskDone {
  status: Exclude<TaskStatus, "running">;
  summary?: string;
  error?: string;
  toolUses?: number;
  durationMs?: number;
  outputFile?: string;
}

interface NeedsYou {
  label: string;
  url: string;
}

export class TaskBoard {
  private tasks = new Map<string, BoardTask>();
  private needs = new Map<string, NeedsYou>();

  constructor(readonly channelId: string, readonly startedAt: number) {}

  get size(): number {
    return this.tasks.size;
  }

  get(id: string): BoardTask | undefined {
    return this.tasks.get(id);
  }

  all(): BoardTask[] {
    return [...this.tasks.values()];
  }

  needsYou(): NeedsYou[] {
    return [...this.needs.values()];
  }

  /** Add tasks that just became live. Removal is driven by done(), not by absence. */
  syncLive(live: LiveTask[], now: number): void {
    for (const t of live) {
      if (this.tasks.has(t.id)) continue;
      this.tasks.set(t.id, { ...t, status: "running", startedAt: now });
    }
  }

  progress(id: string, p: { summary?: string; lastTool?: string; toolUses?: number }): void {
    const t = this.tasks.get(id);
    if (!t || t.status !== "running") return;
    if (p.summary) t.progress = p.summary;
    if (p.lastTool) t.lastTool = p.lastTool;
    if (p.toolUses !== undefined) t.toolUses = p.toolUses;
  }

  done(id: string, d: TaskDone, now: number): void {
    const t = this.tasks.get(id);
    if (!t) return;
    t.status = d.status;
    t.endedAt = d.durationMs !== undefined ? t.startedAt + d.durationMs : now;
    if (d.summary) t.summary = d.summary;
    if (d.error) t.error = d.error;
    if (d.toolUses !== undefined) t.toolUses = d.toolUses;
    if (d.outputFile) t.outputFile = d.outputFile;
  }

  setNeedsYou(key: string, label: string, url: string): void {
    this.needs.set(key, { label, url });
  }

  clearNeedsYou(key: string): void {
    this.needs.delete(key);
  }

  /** Session ended: whatever is still running was killed with it. */
  finalize(now: number): void {
    this.needs.clear();
    for (const t of this.tasks.values()) {
      if (t.status === "running") {
        t.status = "stopped";
        t.endedAt = now;
      }
    }
  }
}

// Each row with a button costs 3 components (Section + TextDisplay + Button);
// the frame (container, header, group headers, separator, stop row, fold
// line) costs ≤ 9. 10 rows keeps the message under Discord's 40 limit.
export const MAX_BOARD_ROWS = 10;

const ICON: Record<TaskStatus, string> = {
  running: "🔄",
  completed: "✅",
  failed: "❌",
  stopped: "⏹️",
  interrupted: "⚠️",
};

function clip(s: string, n: number): string {
  const line = s.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
}

const unix = (ms: number) => Math.floor(ms / 1000);

function runningText(t: BoardTask): string {
  const now = t.progress ? `*“${clip(t.progress, 90)}”*` : t.lastTool ? L(`last: ${t.lastTool}`, `최근: ${t.lastTool}`) : "";
  const tools = t.toolUses ? ` · ${t.toolUses} tools` : "";
  return [`🔄 **${clip(t.description, 80)}**`, now, `-# ${L("started", "시작")} <t:${unix(t.startedAt)}:R>${tools}`]
    .filter(Boolean)
    .join("\n");
}

function finishedText(t: BoardTask): string {
  const dur = t.endedAt ? ` · ${formatElapsed(t.endedAt - t.startedAt)}` : "";
  const tools = t.toolUses ? ` · ${t.toolUses} tools` : "";
  let detail = "";
  if (t.status === "failed") detail = L(`failed: ${clip(t.error ?? t.summary ?? "unknown error", 100)}`, `실패: ${clip(t.error ?? t.summary ?? "", 100)}`);
  else if (t.status === "stopped") detail = L("stopped", "중지됨");
  else if (t.status === "interrupted") detail = L("interrupted (bot restart)", "중단됨 (봇 재시작)");
  else if (t.summary) detail = clip(t.summary, 100);
  return `${ICON[t.status]} **${clip(t.description, 80)}**${dur}${tools}${detail ? `\n-# ${detail}` : ""}`;
}

export interface RenderOpts {
  now: number;
  toolUseCount: number;
  phase: "running" | "done" | "stopped" | "failed";
  showStop: boolean;
  activity?: string;
}

export function renderBoard(board: TaskBoard, o: RenderOpts): ContainerBuilder {
  const tasks = board.all();
  const running = tasks.filter((t) => t.status === "running");
  // Most recent first so the fold hides the oldest.
  const finished = tasks.filter((t) => t.status !== "running").sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  const needs = board.needsYou();

  const accent = { running: 0x5865f2, done: 0x23a55a, stopped: 0x80848e, failed: 0xda373c }[o.phase];
  const c = new ContainerBuilder().setAccentColor(accent);

  const elapsed = formatElapsed(o.now - board.startedAt);
  const head = {
    running: L(`⏳ **Working** · started <t:${unix(board.startedAt)}:R>`, `⏳ **작업 중** · <t:${unix(board.startedAt)}:R> 시작`),
    done: L(`✅ **Done** · ${elapsed}`, `✅ **완료** · ${elapsed}`),
    stopped: L(`⏹️ **Stopped** · ${elapsed}`, `⏹️ **중지됨** · ${elapsed}`),
    failed: L(`❌ **Failed** · ${elapsed}`, `❌ **실패** · ${elapsed}`),
  }[o.phase];
  const sub = [o.phase === "running" && o.activity ? o.activity : "", o.toolUseCount ? `${o.toolUseCount} tools` : ""].filter(Boolean).join(" · ");
  c.addTextDisplayComponents(new TextDisplayBuilder().setContent(sub ? `${head}\n-# ${sub}` : head));

  let budget = MAX_BOARD_ROWS;

  if (needs.length > 0) {
    c.addTextDisplayComponents(new TextDisplayBuilder().setContent(L(`**🟡 Needs you (${needs.length})**`, `**🟡 확인 필요 (${needs.length})**`)));
    for (const n of needs.slice(0, budget)) {
      c.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(`✋ **${clip(n.label, 120)}**`))
          .setButtonAccessory(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(n.url).setLabel(L("Go ↓", "이동 ↓"))),
      );
      budget--;
    }
  }

  if (running.length > 0 && budget > 0) {
    c.addTextDisplayComponents(new TextDisplayBuilder().setContent(L(`**🔄 Running (${running.length})**`, `**🔄 실행 중 (${running.length})**`)));
    const shown = running.slice(0, budget);
    for (const t of shown) c.addTextDisplayComponents(new TextDisplayBuilder().setContent(runningText(t)));
    budget -= shown.length;
    if (running.length > shown.length) {
      c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# 🔄 +${running.length - shown.length} more running`));
    }
  }

  if (finished.length > 0) {
    if (budget > 0) {
      c.addTextDisplayComponents(new TextDisplayBuilder().setContent(L(`**Finished (${finished.length})**`, `**종료 (${finished.length})**`)));
    }
    const shown = finished.slice(0, Math.max(0, budget));
    for (const t of shown) {
      const text = new TextDisplayBuilder().setContent(finishedText(t));
      if (t.summary || t.outputFile || t.error) {
        c.addSectionComponents(
          new SectionBuilder()
            .addTextDisplayComponents(text)
            .setButtonAccessory(
              new ButtonBuilder().setCustomId(`task-out:${board.channelId}:${t.id}`).setStyle(ButtonStyle.Secondary).setEmoji("📄"),
            ),
        );
      } else {
        c.addTextDisplayComponents(text);
      }
    }
    if (finished.length > shown.length) {
      c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ✅ +${finished.length - shown.length} more finished`));
    }
  }

  if (o.showStop) {
    c.addSeparatorComponents(new SeparatorBuilder());
    c.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`stop:${board.channelId}`).setStyle(ButtonStyle.Danger).setEmoji("⏹️").setLabel(L("Stop all", "모두 중지")),
      ),
    );
  }
  return c;
}

/** Ephemeral 📄 reply: full summary / error, plus an output tail for shell tasks. Fits Discord's 2000 chars. */
export function formatTaskDetail(t: BoardTask, outputTail?: string): string {
  const dur = t.endedAt ? formatElapsed(t.endedAt - t.startedAt) : L("still running", "실행 중");
  const parts = [`📄 **${clip(t.description, 80)}** · ${ICON[t.status]} ${t.status} · ${dur}${t.toolUses ? ` · ${t.toolUses} tools` : ""}`];
  if (t.error) parts.push(`**${L("Error", "오류")}:** ${t.error.slice(0, 500)}`);
  if (t.summary) parts.push(t.summary.slice(0, 1200));
  let text = parts.join("\n\n");
  const tail = outputTail?.trim();
  if (tail) {
    const room = 2000 - text.length - "\n\n```\n\n```".length;
    if (room > 40) text += `\n\n\`\`\`\n${tail.slice(-room)}\n\`\`\``;
  }
  return text.slice(0, 2000);
}
