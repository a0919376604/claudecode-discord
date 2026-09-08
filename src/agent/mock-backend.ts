import type { AgentBackend, BackendStartOptions, NormalizedEvent } from "./backend.js";

/**
 * Test helper: an AgentBackend that emits events you push into it.
 * Used by session-manager integration tests to exercise the full Discord
 * UI flow without spawning a real SDK.
 */
export class MockAgentBackend implements AgentBackend {
  private events: NormalizedEvent[] = [];
  private resolvers: ((v: IteratorResult<NormalizedEvent>) => void)[] = [];
  private ended = false;
  private pendingApprovals = new Map<string, (decision: "allow" | "deny") => void>();
  private pendingQuestions = new Map<string, (answers: Record<string, string>) => void>();

  public lastStartOptions: BackendStartOptions | null = null;
  public interruptCalled = 0;
  public approvalResponses: Array<{ requestId: string; decision: "allow" | "deny" }> = [];
  public questionResponses: Array<{ requestId: string; answers: Record<string, string> }> = [];

  enqueueEvent(event: NormalizedEvent): void {
    if (event.type === "tool_approval_request") {
      // Test can wait for the recorded requestId, then call respondToApproval.
    }
    if (event.type === "ask_question_request") {
      // Same for questions.
    }
    if (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()!;
      resolve({ value: event, done: false });
    } else {
      this.events.push(event);
    }
  }

  endStream(): void {
    this.ended = true;
    while (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()!;
      resolve({ value: undefined, done: true });
    }
  }

  async *start(opts: BackendStartOptions): AsyncIterableIterator<NormalizedEvent> {
    this.lastStartOptions = opts;
    while (true) {
      if (this.events.length > 0) {
        yield this.events.shift()!;
        continue;
      }
      if (this.ended) return;
      const next = await new Promise<IteratorResult<NormalizedEvent>>((resolve) => {
        this.resolvers.push(resolve);
      });
      if (next.done) return;
      yield next.value;
    }
  }

  async interrupt(): Promise<void> {
    this.interruptCalled++;
    for (const [, resolve] of this.pendingApprovals) resolve("deny");
    this.pendingApprovals.clear();
    for (const [, resolve] of this.pendingQuestions) resolve({});
    this.pendingQuestions.clear();
    this.endStream();
  }

  respondToApproval(requestId: string, decision: "allow" | "deny"): void {
    this.approvalResponses.push({ requestId, decision });
    this.pendingApprovals.get(requestId)?.(decision);
    this.pendingApprovals.delete(requestId);
  }

  respondToQuestion(requestId: string, answersByQuestionText: Record<string, string>): void {
    this.questionResponses.push({ requestId, answers: answersByQuestionText });
    this.pendingQuestions.get(requestId)?.(answersByQuestionText);
    this.pendingQuestions.delete(requestId);
  }

  isResumeStaleError(_error: unknown): boolean {
    return false;
  }

  getAuthErrorHint(_error: unknown): string | null {
    return null;
  }
}
