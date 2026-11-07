import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentBackend, BackendStartOptions, NormalizedEvent } from "./backend.js";
import { formatQuestionCard, translateDeepTutorEvent } from "./deeptutor-translate.js";
import { getTutor, setTutorSession } from "../db/tutors.js";
import { getConfig } from "../utils/config.js";
import { L } from "../utils/i18n.js";

export class DeepTutorBackend implements AgentBackend {
  private proc: ChildProcess | null = null;

  async *start(opts: BackendStartOptions): AsyncIterableIterator<NormalizedEvent> {
    const tutor = getTutor(opts.channelId);
    if (!tutor) {
      yield { type: "result", isError: true, text: L("No tutor configured for this channel — run /tutor setup", "이 채널에 튜터가 없습니다 — /tutor setup을 실행하세요") };
      return;
    }
    const bin = getConfig().DEEPTUTOR_BIN;
    const proc = spawn(bin, [
      "run", "mastery_path", opts.prompt,
      ...(tutor.deeptutor_session_id ? ["--session", tutor.deeptutor_session_id] : []),
      "--format", "json", "-l", tutor.language,
    ], { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    this.proc = proc;
    const reader = createInterface({ input: proc.stdout! });
    const lines: string[] = [];
    let wake: (() => void) | undefined;
    const notify = () => { wake?.(); wake = undefined; };
    let stderr = Buffer.alloc(0);
    let stale = false;
    let finished = false;
    let exited = false;
    let stdoutClosed = false;
    let exitCode: number | null = null;
    let spawnError: NodeJS.ErrnoException | undefined;
    let terminalEventSeen = false;
    reader.on("line", line => {
      stale ||= /Conversation not found/i.test(line);
      lines.push(line);
      notify();
    });
    reader.on("close", () => { stdoutClosed = true; if (exited) { finished = true; notify(); } });
    const onStderr = (chunk: Buffer) => {
      const combined = Buffer.concat([stderr, chunk]);
      stale ||= /Conversation not found/i.test(combined.toString());
      stderr = combined.subarray(-8192);
    };
    proc.stderr!.on("data", onStderr);
    proc.once("error", (error: NodeJS.ErrnoException) => {
      spawnError = error;
      exited = finished = true;
      notify();
    });
    proc.once("exit", (code: number | null) => {
      exited = true;
      exitCode = code;
      if (stdoutClosed) { finished = true; notify(); }
    });
    proc.once("close", () => { finished = true; notify(); });
    const staleMessage = () => L(
      "This tutor's DeepTutor session is gone — run /tutor reset to start a new learning path.",
      "이 튜터의 DeepTutor 세션이 없습니다 — /tutor reset으로 새 학습 경로를 시작하세요.",
    );
    let sessionSeen = false;
    const cards = new Set<string>();
    try {
      while (true) {
        if (lines.length) {
          const line = lines.shift()!;
          let raw: Record<string, unknown> | null;
          try { raw = JSON.parse(line); } catch { continue; }
          const mapped = translateDeepTutorEvent(raw);
          const id = mapped.find(e => e.type === "session_init")?.sessionId ?? raw?.session_id;
          if (!sessionSeen && typeof id === "string" && id) {
            sessionSeen = true;
            if (!tutor.deeptutor_session_id) setTutorSession(opts.channelId, id);
            yield { type: "session_init", sessionId: id };
          }
          const metadata = raw?.metadata as { tool_metadata?: { mastery_question?: unknown } } | undefined;
          const card = formatQuestionCard(metadata?.tool_metadata?.mastery_question);
          for (const [index, event] of mapped.entries()) {
            if (event.type === "session_init") continue;
            if (event.type === "text_delta" && index === mapped.length - 1 && event.text === card) {
              if (cards.has(card)) continue;
              cards.add(card);
            }
            if (event.type === "result") {
              terminalEventSeen = true;
              reader.close();
              proc.unref();
              yield stale ? { type: "result", isError: true, text: staleMessage() } : event;
              return;
            }
            yield event;
          }
          continue;
        }
        if (finished) break;
        await new Promise<void>(resolve => { wake = resolve; });
      }
      const text = spawnError?.code === "ENOENT"
        ? L(`DeepTutor CLI not found (DEEPTUTOR_BIN=${bin}).`, `DeepTutor CLI를 찾을 수 없습니다 (DEEPTUTOR_BIN=${bin}).`)
        : stale ? staleMessage()
        : spawnError?.message || stderr.toString().trim().split(/\r?\n/).slice(-8).join("\n")
          || L(`DeepTutor exited with code ${exitCode}`, `DeepTutor가 코드 ${exitCode}로 종료되었습니다`);
      yield { type: "result", text, isError: true };
    } finally {
      reader.close();
      proc.stderr!.off("data", onStderr);
      if (!terminalEventSeen && !exited && !proc.killed) proc.kill("SIGTERM");
      if (this.proc === proc) this.proc = null;
    }
  }

  async interrupt(): Promise<void> { this.proc?.kill("SIGTERM"); }
  respondToApproval(): void { /* DeepTutor CLI has no approval protocol. */ }
  respondToQuestion(): void { /* Answers arrive as the next channel message. */ }
  isResumeStaleError(_error: unknown): boolean { return false; }
  getAuthErrorHint(error: unknown): string | null {
    const message = error instanceof Error ? error.message : String(error);
    if (/not found \(DEEPTUTOR_BIN|ENOENT/.test(message)) {
      return L("Install DeepTutor with `pip install -e .` in the DeepTutor checkout, then set DEEPTUTOR_BIN if needed.", "DeepTutor 저장소에서 `pip install -e .`로 설치하고 필요하면 DEEPTUTOR_BIN을 설정하세요.");
    }
    if (/api key|provider|llm/i.test(message)) {
      return L("Configure the DeepTutor LLM provider and its API key.", "DeepTutor LLM 제공자와 API 키를 설정하세요.");
    }
    return null;
  }
}
