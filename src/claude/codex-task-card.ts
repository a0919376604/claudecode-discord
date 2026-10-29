import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type Message } from "discord.js";
import type { NormalizedEvent } from "../agent/backend.js";
import { formatToolActivity } from "./tool-activity.js";
import { L } from "../utils/i18n.js";

export type CardPhase = "running" | "waiting" | "stopping" | "done" | "failed" | "stopped";
type Step = { step: string; status: "pending" | "inProgress" | "completed" };
const clip = (text: string, max: number) => text.length > max ? text.slice(0, max - 1) + "…" : text;
const labels = () => ({
  running: L("Working", "작업 중"), waiting: L("Needs you", "응답 필요"),
  stopping: L("Stopping…", "중지 중…"), done: L("Completed", "완료"),
  failed: L("Needs attention", "확인 필요"), stopped: L("Stopped", "중지됨"),
});

/** One persistent progress message; assistant output stays in ordinary messages. */
export class CodexTaskCard {
  private state: CardPhase = "running";
  private message?: Message;
  private timer?: NodeJS.Timeout;
  private edits: Promise<void> = Promise.resolve();
  private renderedAt = 0;
  private updatedAt: number;
  private finishedAt?: number;
  private activity = L("Connecting to Codex…", "Codex 연결 중…");
  private history: string[] = [];
  private needs = new Map<string, { label: string; url: string }>();
  private steps: Step[] = [];
  private planTotal = 0;
  private planCompleted = 0;
  private currentStep?: string;
  private summary = "";
  private toolUses = 0;
  model?: string;
  readonly title: string;

  constructor(readonly runId: string, prompt: string, readonly startedAt = Date.now()) {
    this.updatedAt = startedAt;
    this.title = clip(prompt.replace(/^.*<\/channel>\s*/s, "").trim().split("\n").find(Boolean) ?? "Codex task", 100);
  }

  get phase(): CardPhase { return this.state === "running" && this.needs.size ? "waiting" : this.state; }
  get terminal(): boolean { return ["done", "failed", "stopped"].includes(this.state); }
  get url(): string | undefined { return this.message?.url; }
  attach(message: Message): void { this.message = message; }

  observe(event: NormalizedEvent): void {
    if (this.terminal || this.state === "stopping") return;
    this.updatedAt = Date.now();
    switch (event.type) {
      case "session_init":
        this.model = event.model ?? this.model;
        this.activity = L("Thinking…", "생각 중…");
        break;
      case "text_delta":
        this.activity = event.isReasoning ? L("Thinking…", "생각 중…") : L("Writing response…", "응답 작성 중…");
        break;
      case "tool_start":
        this.toolUses++;
        this.activity = formatToolActivity(event.toolName, event.input);
        this.record(this.activity);
        break;
      case "tool_end":
        this.activity = event.input ? formatToolActivity(event.toolName, event.input, event.ok) : `${event.ok ? "✓" : "!"} ${event.toolName}`;
        this.record(this.activity);
        break;
      case "plan_update":
        this.planTotal = event.steps.length;
        this.planCompleted = event.steps.filter(s => s.status === "completed").length;
        this.currentStep = (event.steps.find(s => s.status === "inProgress") ?? event.steps.find(s => s.status === "pending"))?.step;
        this.steps = event.steps.slice(0, 30);
        break;
      default: return;
    }
    this.schedule();
  }

  private record(text: string): void { this.history = [...this.history.slice(-7), clip(text, 180)]; }
  need(id: string, label: string, url: string): void {
    if (this.terminal || this.state === "stopping") return;
    this.needs.set(id, { label: clip(label, 180), url });
    this.schedule();
  }
  clearNeed(id: string): void { this.needs.delete(id); this.schedule(); }
  requestStop(): void {
    if (this.terminal) return;
    this.state = "stopping";
    this.schedule();
  }
  async finish(phase: "done" | "failed" | "stopped", summary = ""): Promise<void> {
    if (this.terminal) return;
    this.state = phase;
    this.summary = clip(summary, 1600);
    this.finishedAt = Date.now();
    this.needs.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.flush();
  }

  schedule(): void {
    if (this.terminal || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, Math.max(0, 1500 - (Date.now() - this.renderedAt)));
  }
  flush(): Promise<void> {
    this.edits = this.edits.then(async () => {
      if (!this.message) return;
      // Render at execution time so queued edits cannot restore stale state.
      await this.message.edit(this.render());
      this.renderedAt = Date.now();
    }).catch((error: unknown) => console.warn("[codex-card] Could not update task card:", error));
    return this.edits;
  }

  render(now = Date.now()) {
    const phase = this.phase;
    const colors = { running: 0x5865f2, waiting: 0xfee75c, stopping: 0xfee75c, done: 0x57f287, failed: 0xed4245, stopped: 0x949ba4 };
    const elapsed = Math.max(0, Math.floor(((this.finishedAt ?? now) - this.startedAt) / 1000));
    const embed = new EmbedBuilder().setColor(colors[phase])
      .setAuthor({ name: `CODEX · ${labels()[phase]}` }).setTitle(this.title)
      .setDescription(this.terminal
        ? clip(this.summary || L("The task has ended. See the response below.", "작업이 종료되었습니다. 아래 응답을 확인하세요."), 850)
        : clip(this.activity, 400))
      .addFields({ name: L("Actual model", "실제 모델"), value: clip(this.model ?? L("Waiting for backend", "백엔드 응답 대기"), 100), inline: true })
      .setFooter({ text: `${elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ` : ""}${elapsed % 60}s · ${this.toolUses} ${L("tool calls", "도구 호출")} · ${this.runId.slice(0, 8)}` });
    if (!this.terminal) {
      embed.addFields({ name: L("Last event", "최근 이벤트"), value: `<t:${Math.floor(this.updatedAt / 1000)}:R>`, inline: true });
    }
    if (this.steps.length) {
      embed.addFields({ name: `${L("Reported plan", "보고된 계획")} · ${this.planCompleted}/${this.planTotal}`, value: clip(this.currentStep ?? L("All reported steps complete", "보고된 단계 모두 완료"), 300) });
    }
    const need = this.needs.values().next().value;
    if (need) embed.addFields({ name: L("Needs you", "응답 필요"), value: `${need.label}\n[${L("Open request", "요청 보기")}](${need.url})` });
    if (phase === "failed" || phase === "stopped") {
      embed.addFields({ name: L("Next step", "다음 단계"), value: L("Review the details, then check existing work and continue. Completed changes will be inspected first.", "상세 내용을 확인한 뒤 기존 작업을 점검하고 계속하세요. 완료된 변경 사항을 먼저 확인합니다.") });
    }
    const button = (action: string, label: string, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(`card-${action}:${this.runId}`).setLabel(label).setStyle(style);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      button("details", L("Details", "상세")), button("model", L("Model", "모델")),
    );
    if (!this.terminal) row.addComponents(button("stop", L("Stop", "중지"), ButtonStyle.Danger).setDisabled(phase === "stopping"));
    else if (phase !== "done") row.addComponents(button("recover", L("Check & continue", "점검 후 계속"), ButtonStyle.Primary));
    return { content: "", embeds: [embed], components: [row], allowedMentions: { parse: [] as [] } };
  }

  details(): string {
    const plan = this.steps.map(s => `${s.status === "completed" ? "✓" : s.status === "inProgress" ? "→" : "○"} ${clip(s.step, 100)}`).join("\n");
    return clip(`**${this.title}**\n${labels()[this.phase]} · ${this.model ?? "Codex"}\n\n${this.summary ? clip(this.summary, 700) + "\n\n" : ""}${plan ? clip(plan, 500) + "\n\n" : ""}${this.history.join("\n") || this.activity}`, 1950);
  }
}
