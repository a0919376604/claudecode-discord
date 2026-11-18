import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, type Message, type TextChannel } from "discord.js";
import type { NormalizedEvent } from "../agent/backend.js";
import type { CardPhase } from "./codex-task-card.js";
import { InlineToolStore, clip, safeToolText } from "./inline-tool-store.js";
import { splitMessage } from "./output-formatter.js";
import { L } from "../utils/i18n.js";

interface TextBlock {
  kind: "text"; itemId?: string; text: string; messages: Message[]; rendered: string[]; dirty: boolean; sealed: boolean;
}
interface ToolBlock {
  kind: "tools"; ids: string[]; message?: Message; dirty: boolean; sealed: boolean;
}
type Block = TextBlock | ToolBlock;
type Payload = { content: string; embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[]; allowedMentions: { parse: [] } };
const payload = (content = "", embed?: EmbedBuilder, row?: ActionRowBuilder<ButtonBuilder>): Payload => ({
  content, embeds: embed ? [embed] : [], components: row ? [row] : [], allowedMentions: { parse: [] },
});
const phaseLabel = (phase: CardPhase) => ({
  running: L("Working", "작업 중"), waiting: L("Needs you", "응답 필요"), stopping: L("Stopping…", "중지 중…"),
  done: L("Completed", "완료"), failed: L("Needs attention", "확인 필요"), stopped: L("Stopped", "중지됨"),
})[phase];

/** One chronological transcript. Every write, including timer flushes, uses the same queue. */
export class CodexConversation {
  private state: CardPhase = "running";
  private tools = new InlineToolStore();
  private blocks: Block[] = [];
  private textItems = new Map<string, TextBlock>();
  private toolBlocks = new Map<string, ToolBlock>();
  private current?: Block;
  private placeholder?: Message;
  private latest?: Message;
  private timer?: NodeJS.Timeout;
  private queue: Promise<void> = Promise.resolve();
  private renderedAt = 0;
  private lastEventAt = Date.now();
  private finishedAt?: number;
  private needs = new Map<string, { label: string; url: string }>();
  private steps: Array<{ step: string; status: string }> = [];
  private summary = "";
  private textSeen = false;
  private finalMessage?: Message;
  private finishing?: Promise<void>;
  private delivered = false;
  model?: string;
  readonly title: string;

  constructor(readonly runId: string, prompt: string, private channel: TextChannel, readonly startedAt = Date.now()) {
    this.title = clip(prompt.replace(/^.*<\/channel>\s*/s, "").trim().split("\n").find(Boolean) ?? "Codex task", 100);
  }
  get phase(): CardPhase { return this.state === "running" && this.needs.size ? "waiting" : this.state; }
  get terminal(): boolean { return ["done", "failed", "stopped"].includes(this.state); }
  get url(): string | undefined { return this.latest?.url; }
  attach(message: Message): void { this.placeholder = message; this.latest = message; }

  private controls(active = true): ActionRowBuilder<ButtonBuilder> {
    const button = (action: string, text: string, style = ButtonStyle.Secondary) =>
      new ButtonBuilder().setCustomId(`card-${action}:${this.runId}`).setLabel(text).setStyle(style);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      button("details", L("Details", "상세")), button("model", L("Model", "모델")),
    );
    if (active && !this.terminal) row.addComponents(button("stop", L("Stop", "중지"), ButtonStyle.Danger).setDisabled(this.phase === "stopping"));
    return row;
  }

  render(now = Date.now()): Payload {
    const phase = this.phase;
    const embed = new EmbedBuilder().setColor(this.color())
      .setAuthor({ name: `CODEX · ${phaseLabel(phase)}` }).setTitle(this.title)
      .setDescription(clip(this.summary || (this.terminal
        ? L("See the response above.", "위 응답을 확인하세요.")
        : this.needs.values().next().value?.label ?? L("Connecting to Codex…", "Codex 연결 중…")), 1800))
      .setFooter({ text: this.footer(now) });
    if (this.model) embed.addFields({ name: L("Actual model", "실제 모델"), value: clip(safeToolText(this.model), 100) });
    const row = this.controls();
    if (phase === "failed" || phase === "stopped") row.addComponents(new ButtonBuilder()
      .setCustomId(`card-recover:${this.runId}`).setLabel(L("Check & continue", "점검 후 계속")).setStyle(ButtonStyle.Primary));
    return payload("", embed, row);
  }

  private color(phase = this.phase): number {
    return { running: 0x5865f2, waiting: 0xfee75c, stopping: 0x949ba4, done: 0x57f287, failed: 0xed4245, stopped: 0x949ba4 }[phase];
  }
  private footer(now = Date.now()): string {
    const elapsed = Math.max(0, Math.floor(((this.finishedAt ?? now) - this.startedAt) / 1000));
    return `${elapsed}s · ${this.tools.count} ${L("tool calls", "도구 호출")}${this.model ? ` · ${clip(safeToolText(this.model), 70)}` : ""} · ${this.runId.slice(0, 8)}`;
  }
  private renderTools(block: ToolBlock): Payload {
    const visible = block.ids.slice(-4);
    const description = this.tools.rows(visible);
    const states = block.ids.map(id => this.tools.get(id)?.status);
    const phase: CardPhase = states.includes("running")
      ? this.phase === "stopping" ? "stopping" : this.needs.size ? "waiting" : "running"
      : states.some(s => s === "failed" || s === "declined" || s === "unknown") ? "failed"
      : states.includes("stopped") ? "stopped" : "done";
    const embed = new EmbedBuilder().setColor(this.color(phase)).setAuthor({ name: `CODEX · ${phaseLabel(phase)}` })
      .setTitle(L("Tool activity", "도구 활동")).setDescription(clip(description || L("Waiting for tool details", "도구 정보 대기"), 3500))
      .setFooter({ text: this.footer() });
    if (block.ids.length > 4) embed.addFields({ name: L("Earlier tools", "이전 도구"), value: L(`${block.ids.length - 4} more · open Details`, `${block.ids.length - 4}개 더 · 상세 보기`) });
    if (!this.terminal) {
      const age = Math.max(0, Math.floor((Date.now() - this.lastEventAt) / 1000));
      embed.addFields({ name: L("Activity", "진행 상황"), value: `${this.tools.running} ${L("running", "실행 중")}${age >= 15 ? ` · ${L("No new output", "새 출력 없음")} ${age}s` : ""}` });
    }
    const need = this.needs.values().next().value;
    if (need) embed.addFields({ name: L("Needs you", "응답 필요"), value: `${clip(safeToolText(need.label), 180)}\n[${L("Open request", "요청 보기")}](${need.url})` });
    return payload("", embed, this.controls(block === this.current && !block.sealed));
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.queue.then(work);
    // A failed edit must not poison future finalization or other transcript blocks.
    this.queue = next.catch(() => {});
    return next;
  }
  private async write(message: Message | undefined, data: Payload): Promise<Message> {
    for (let attempt = 0; ; attempt++) {
      try {
        if (message) { await message.edit(data); return message; }
        return await this.channel.send({ ...data, flags: MessageFlags.SuppressNotifications });
      } catch (error) {
        const e = error as { code?: number; status?: number; retry_after?: number; rawError?: { retry_after?: number } };
        if (message && e.code === 10008) { message = undefined; continue; }
        const seconds = e.retry_after ?? e.rawError?.retry_after;
        if (e.status === 429 && typeof seconds === "number" && seconds >= 0 && seconds <= 30 && attempt < 2) {
          await new Promise(resolve => setTimeout(resolve, Math.ceil(seconds * 1000)));
          continue;
        }
        throw error;
      }
    }
  }
  private takePlaceholder(): Message | undefined { const m = this.placeholder; this.placeholder = undefined; return m; }

  /** Historical segments stay frozen. Force refreshes only the current segment. */
  flush(force = false, keepGoing = false): Promise<void> {
    return this.enqueue(async () => {
      let firstError: unknown;
      for (const block of this.blocks) {
        if (!block.dirty && !(force && block === this.current)) continue;
        // Clear before the first await: events received during a slow write set
        // dirty again and must survive for the next queued/timer flush.
        block.dirty = false;
        try {
          if (block.kind === "tools") {
            block.message ??= this.takePlaceholder();
            block.message = await this.write(block.message, this.renderTools(block));
            if (block === this.current) this.latest = block.message;
          } else {
            const chunks = splitMessage(block.text);
            for (let i = 0; i < chunks.length; i++) {
              const row = block === this.current && !block.sealed && !this.terminal && i === chunks.length - 1 ? this.controls() : undefined;
              const data = payload(chunks[i], undefined, row);
              const rendered = JSON.stringify(data);
              if (force || rendered !== block.rendered[i] || !block.messages[i]) {
                if (!block.messages[i] && i === 0) {
                  const initial = this.takePlaceholder();
                  if (initial) block.messages[i] = initial;
                }
                block.messages[i] = await this.write(block.messages[i], data);
                block.rendered[i] = rendered;
              }
            }
            // Authoritative completed text may be shorter than its streamed preview.
            for (const obsolete of block.messages.splice(chunks.length)) await obsolete.delete().catch(() => {});
            block.rendered.length = chunks.length;
            if (block === this.current) this.latest = block.messages.at(-1) ?? this.latest;
          }
        } catch (error) {
          block.dirty = true;
          if (!keepGoing) throw error;
          firstError ??= error;
        }
      }
      if (this.placeholder) await this.write(this.placeholder, this.render());
      this.renderedAt = Date.now();
      if (firstError) throw firstError;
    });
  }
  schedule(): void {
    if (this.terminal || this.timer) return;
    if (this.current) this.current.dirty = true;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush(false).catch(error => console.warn("[codex-inline] Progress update failed:", error));
    }, Math.max(0, 1500 - (Date.now() - this.renderedAt)));
  }
  private cancelTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  private async sealCurrent(): Promise<void> {
    this.cancelTimer();
    if (this.current) { this.current.sealed = true; this.current.dirty = true; }
    await this.flush(false);
    this.current = undefined;
  }

  async observe(event: NormalizedEvent): Promise<void> {
    if (this.terminal || this.state === "stopping") return;
    if (event.type === "text_delta" && event.isReasoning) return;
    this.lastEventAt = Date.now();
    if (event.type === "session_init") { this.model = event.model ?? this.model; this.schedule(); return; }
    if (event.type === "plan_update") { this.steps = event.steps; return; }
    if (event.type === "tool_approval_request" || event.type === "ask_question_request") { await this.sealCurrent(); return; }
    if (event.type === "text_delta" || event.type === "text_complete") {
      if (!event.text) return;
      let block = event.itemId ? this.textItems.get(event.itemId) : undefined;
      if (!block && this.current?.kind === "text" && (!event.itemId || this.current.itemId === event.itemId)) block = this.current;
      if (!block) {
        await this.sealCurrent();
        block = { kind: "text", itemId: event.itemId, text: "", messages: [], rendered: [], dirty: true, sealed: false };
        this.blocks.push(block); this.current = block;
        if (event.itemId) this.textItems.set(event.itemId, block);
      }
      block.text = event.type === "text_complete" ? event.text : block.text + event.text;
      block.dirty = true; this.textSeen = true;
      if (event.type === "text_complete") await this.flush(false);
      else this.schedule();
      return;
    }
    const id = this.tools.observe(event);
    if (!id) return;
    let block = this.toolBlocks.get(id);
    if (!block) {
      if (this.current?.kind !== "tools") {
        await this.sealCurrent();
        block = { kind: "tools", ids: [], dirty: true, sealed: false };
        this.blocks.push(block); this.current = block;
      } else block = this.current;
      block.ids.push(id); this.toolBlocks.set(id, block);
    }
    block.dirty = true;
    if (!block.message) await this.flush(false);
    else this.schedule();
  }

  need(id: string, label: string, url: string): void {
    if (this.terminal || this.state === "stopping") return;
    this.needs.set(id, { label, url });
    this.markActive();
    this.schedule();
  }
  clearNeed(id: string): void {
    this.needs.delete(id);
    this.markActive();
    this.schedule();
  }
  requestStop(): void {
    if (this.terminal) return;
    this.state = "stopping";
    this.markActive();
    this.schedule();
  }
  async finish(phase: "done" | "failed" | "stopped", summary = ""): Promise<void> {
    if (this.delivered) return;
    if (this.finishing) return this.finishing;
    this.finishing = this.finishDelivery(phase, summary);
    try { await this.finishing; }
    finally { this.finishing = undefined; }
  }
  private markActive(): void {
    for (const block of this.blocks) if (block === this.current || (block.kind === "tools" && block.ids.some(id => this.tools.get(id)?.status === "running"))) block.dirty = true;
  }
  private async finishDelivery(phase: "done" | "failed" | "stopped", summary: string): Promise<void> {
    if (!this.terminal) {
      if (phase === "done" && !this.textSeen && summary) await this.observe({ type: "text_delta", text: summary });
      // Stop can arrive while the fallback text is being prepared.
      if (this.state === "stopping") phase = "stopped";
      this.cancelTimer(); this.markActive();
      this.state = phase; this.finishedAt = Date.now();
      this.summary = phase === "done" ? "" : clip(safeToolText(summary), 1800);
      this.needs.clear(); this.tools.finalize(phase === "stopped");
    }
    // Task outcome is immutable; incomplete Discord delivery is retryable.
    // A failed block never prevents cleanup of the remaining blocks or the result.
    for (let attempt = 0; attempt < 2; attempt++) {
      let failure: unknown;
      try { await this.flush(false, true); } catch (error) { failure = error; }
      try {
        await this.enqueue(async () => {
          this.finalMessage ??= this.takePlaceholder();
          this.finalMessage = await this.write(this.finalMessage, this.render());
          this.latest = this.finalMessage;
        });
      } catch (error) { failure ??= error; }
      if (!failure) { this.delivered = true; return; }
      if (attempt === 1) throw failure;
    }
  }
  details(): string {
    const plan = this.steps.slice(-10).map(step => `${step.status === "completed" ? "✓" : step.status === "inProgress" ? "→" : "○"} ${clip(safeToolText(step.step), 100)}`).join("\n");
    return clip(`**${safeToolText(this.title)}**\n${phaseLabel(this.phase)}${this.model ? ` · ${safeToolText(this.model)}` : ""}\n\n${this.tools.details()}${plan ? `\n\n${plan}` : ""}${this.summary ? `\n\n${this.summary}` : ""}`, 1950);
  }
}
