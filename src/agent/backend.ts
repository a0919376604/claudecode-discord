import type { AskQuestionData } from "../claude/output-formatter.js";

export type NormalizedEvent =
  | { type: "session_init"; sessionId: string }
  | { type: "text_delta"; text: string; isReasoning?: boolean }
  | { type: "tool_start"; toolName: string; input: Record<string, unknown> }
  | { type: "tool_end"; toolName: string; ok: boolean }
  | { type: "result"; text: string; costUsd?: number; isError: boolean }
  | { type: "tool_approval_request"; requestId: string; toolName: string; input: Record<string, unknown> }
  | { type: "ask_question_request"; requestId: string; questions: AskQuestionData[] };

export interface BackendStartOptions {
  prompt: string;
  cwd: string;
  resumeSessionId?: string;
  skipPermissions: boolean;
  channelId: string;
  model?: string;
}

export interface AgentBackend {
  start(opts: BackendStartOptions): AsyncIterableIterator<NormalizedEvent>;
  interrupt(): Promise<void>;
  respondToApproval(requestId: string, decision: "allow" | "deny", message?: string): void;
  respondToQuestion(requestId: string, answersByQuestionText: Record<string, string>): void;
  isResumeStaleError(error: unknown): boolean;
  getAuthErrorHint(error: unknown): string | null;
}

/** Re-export for downstream consumers. */
export type { AskQuestionData };
