import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Message, TextChannel } from "discord.js";
import {
  upsertSession,
  updateSessionStatus,
  getProject,
  getSession,
  setAutoApprove,
} from "../db/database.js";
import { getConfig } from "../utils/config.js";
import { pluginRegistry } from "../bot/client.js";
import { L } from "../utils/i18n.js";
import { isSkipPermissionsEnabled } from "../utils/skip-permissions.js";
import {
  createToolApprovalEmbed,
  createAskUserQuestionEmbed,
  createResultEmbed,
  createStopButton,
  createCompletedButton,
  createFinishFeatureButton,
  splitMessage,
  type AskQuestionData,
} from "./output-formatter.js";
import {
  decideProgressAction,
  buildProgressContent,
} from "./progress-decision.js";
import { ensureFreshCredentials } from "./credentials-refresher.js";

/**
 * After Claude has streamed any text, the original Discord message holds real
 * content and can no longer be safely overwritten by progress updates. Once
 * Claude has been silent (no new text) for this many milliseconds while still
 * doing tool work, we send a SEPARATE progress message below the streamed
 * text so the user can see the session is still alive.
 *
 * 30s balances "I want to see progress" vs "don't spam new messages every
 * tool call." Override via env if a project prefers tighter feedback.
 */
const PROGRESS_STALE_MS = Number(process.env.PROGRESS_STALE_MS) > 0
  ? Number(process.env.PROGRESS_STALE_MS)
  : 30_000;

/**
 * Finalize `buffer` to Discord. Used by:
 *   (a) the streaming throttle path — when the 1500ms edit gate fires
 *   (b) the canUseTool flush — when a tool is about to show approval /
 *       question UI and we want preceding explanation text visible
 *
 * Returns the new "tail" Message (callers should treat this as the new
 * currentMessage for any subsequent streaming) and a `remainingBuffer`
 * value that callers in the throttle path should assign back to their
 * local buffer to preserve the existing cumulative-buffer behavior
 * (single-chunk: buffer preserved; multi-chunk overflow: buffer drained).
 *
 * Empty buffer is a zero-API-call no-op.
 *
 * Exported for unit testing — not part of the SessionManager class.
 */
export async function flushStreamBuffer(
  channel: TextChannel,
  currentMessage: Message,
  buffer: string,
): Promise<{ tail: Message; remainingBuffer: string }> {
  if (buffer.length === 0) {
    return { tail: currentMessage, remainingBuffer: "" };
  }

  const chunks = splitMessage(buffer);
  let tail = currentMessage;
  let remainingBuffer = buffer;

  try {
    await currentMessage.edit({
      content: chunks[0] || "...",
      components: [],
    });
    // Send overflow chunks as new messages. We track remainingBuffer the
    // way the original throttle path did: after each send, drop the
    // already-sent prefix so a future edit of `tail` (the new
    // currentMessage) won't re-render text the user has already seen.
    for (let i = 1; i < chunks.length; i++) {
      tail = await channel.send(chunks[i]);
      remainingBuffer = chunks.slice(i + 1).join("");
    }
  } catch (e) {
    console.warn(
      `[flush] Failed to edit ${currentMessage.id ?? "(unknown id)"}, sending new:`,
      e instanceof Error ? e.message : e,
    );
    tail = await channel.send({
      content: chunks[chunks.length - 1] || "...",
      components: [],
    });
  }

  return { tail, remainingBuffer };
}

interface ActiveSession {
  queryInstance: Query;
  channelId: string;
  sessionId: string | null; // Claude Agent SDK session ID
  dbId: string;
}

// Pending approval requests: requestId -> resolve function
const pendingApprovals = new Map<
  string,
  {
    resolve: (decision: { behavior: "allow" | "deny"; message?: string }) => void;
    channelId: string;
  }
>();

// Pending AskUserQuestion requests: requestId -> resolve function
const pendingQuestions = new Map<
  string,
  {
    resolve: (answer: string | null) => void;
    channelId: string;
  }
>();

// Pending custom text inputs: channelId -> requestId
const pendingCustomInputs = new Map<string, { requestId: string }>();

class SessionManager {
  private sessions = new Map<string, ActiveSession>();
  private static readonly MAX_QUEUE_SIZE = 5;
  private messageQueue = new Map<string, { channel: TextChannel; prompt: string }[]>();
  private pendingQueuePrompts = new Map<string, { channel: TextChannel; prompt: string }>();

  async sendMessage(
    channel: TextChannel,
    prompt: string,
  ): Promise<void> {
    const channelId = channel.id;

    // Best-effort: keep the macOS Keychain access token fresh before
    // we spawn a `claude` subprocess. No-op on non-darwin and when
    // the token is still well within expiry. Never throws.
    await ensureFreshCredentials();

    const project = getProject(channelId);
    if (!project) return;

    const existingSession = this.sessions.get(channelId);
    // If no in-memory session, check DB for previous session_id (for bot restart resume)
    const dbSession = !existingSession ? getSession(channelId) : undefined;
    const dbId = existingSession?.dbId ?? dbSession?.id ?? randomUUID();
    const resumeSessionId = existingSession?.sessionId ?? dbSession?.session_id ?? undefined;

    // Update status to online
    upsertSession(dbId, channelId, resumeSessionId ?? null, "online");

    // Streaming state
    let responseBuffer = "";
    let lastEditTime = 0;
    const stopRow = createStopButton(channelId);
    let currentMessage: Message = await channel.send({
      content: L("⏳ Thinking...", "⏳ 생각 중..."),
      components: [stopRow],
    });
    const EDIT_INTERVAL = 1500; // ms between edits (Discord rate limit friendly)

    // Activity tracking for progress display
    const startTime = Date.now();
    let lastActivity = L("Thinking...", "생각 중...");
    let toolUseCount = 0;
    let hasTextOutput = false;
    let hasResult = false;
    // Timestamp of the last assistant-text streaming edit. Used to decide
    // whether the post-text phase has been silent long enough that we should
    // surface a separate "still working" progress message.
    let lastTextTime = startTime;
    // Progress message created during a silent tool-work phase (post-text).
    // Reset to null whenever fresh text streams so the next stale window
    // creates a new snapshot below the latest streamed content.
    // The `as` cast widens the inferred type past the literal `null` so TS
    // doesn't treat later assignments inside async closures as `never`.
    let progressMessage = null as Message | null;

    /**
     * Single entry point for "show the user we're still working." Dispatches
     * to either the initial Thinking message (pre-text) or a separate
     * progress message (post-text, when streaming has been silent for a
     * while). See progress-decision.ts for the rationale.
     */
    const surfaceProgress = async () => {
      const content = buildProgressContent(
        lastActivity,
        Date.now() - startTime,
        toolUseCount,
      );
      const action = decideProgressAction({
        hasTextOutput,
        lastTextTime,
        now: Date.now(),
        staleThresholdMs: PROGRESS_STALE_MS,
        progressMessageExists: progressMessage !== null,
      });

      try {
        switch (action) {
          case "skip":
            return;
          case "edit-current":
            await currentMessage.edit({ content, components: [stopRow] });
            return;
          case "edit-progress":
            if (progressMessage) {
              await progressMessage.edit({ content, components: [stopRow] });
            }
            return;
          case "send-progress":
            progressMessage = await channel.send({ content, components: [stopRow] });
            return;
        }
      } catch (e) {
        console.warn(
          `[progress] Failed to surface progress for ${channelId}:`,
          e instanceof Error ? e.message : e,
        );
      }
    };

    // Heartbeat timer — surfaces progress every 15s for as long as the
    // session is active. Unlike the previous implementation, this does NOT
    // bail once hasTextOutput is true; surfaceProgress decides whether to
    // edit the original message, the progress message, or stay quiet.
    const heartbeatInterval = setInterval(surfaceProgress, 15_000);

    // Hard ceiling on session duration. Bounds runaway token cost when a
    // prompt sends Claude into a long loop (the original failure mode the
    // user reported was an hour-long silent session). Set
    // MAX_SESSION_DURATION_MIN=0 to disable the ceiling for trusted local
    // dev. The timeout looks up the *current* queryInstance via
    // this.sessions so it interrupts the right one even after a
    // resume-retry has swapped instances.
    const maxDurationMin = getConfig().MAX_SESSION_DURATION_MIN;
    const sessionsRef = this.sessions;
    const durationTimer: NodeJS.Timeout | null = maxDurationMin > 0
      ? setTimeout(async () => {
          console.warn(
            `[session] Max duration ${maxDurationMin}min reached for ${channelId}, interrupting`,
          );
          const active = sessionsRef.get(channelId);
          if (active) {
            // 3s race: interrupt() can stall indefinitely on non-streaming
            // queries (see stopSession for the full explanation). We don't
            // want the timeout handler itself to wedge.
            Promise.race([
              active.queryInstance.interrupt(),
              new Promise((resolve) => setTimeout(resolve, 3_000)),
            ]).catch((e) => {
              console.warn(
                `[timeout] interrupt failed for ${channelId}:`,
                e instanceof Error ? e.message : e,
              );
            });
            // Force-evict so the channel is usable again even if interrupt
            // never returns.
            sessionsRef.delete(channelId);
          }
          try {
            await channel.send(
              L(
                `⏱️ Session exceeded ${maxDurationMin}-minute max duration and was interrupted to bound runaway token cost. Raise MAX_SESSION_DURATION_MIN (or set 0 to disable) if your workflow legitimately needs longer.`,
                `⏱️ 세션이 ${maxDurationMin}분 최대 시간을 초과하여 토큰 비용 폭주를 막기 위해 중단되었습니다. 더 긴 시간이 필요하면 MAX_SESSION_DURATION_MIN을 늘리거나 0으로 설정해 비활성화하세요.`,
              ),
            );
          } catch (e) {
            console.warn(
              `[timeout] Failed to send timeout message for ${channelId}:`,
              e instanceof Error ? e.message : e,
            );
          }
        }, maxDurationMin * 60_000)
      : null;

    const skipPerms = isSkipPermissionsEnabled();
    const runQuery = (useResume: boolean) => query({
      prompt,
      options: {
        cwd: project.project_path,
        plugins: pluginRegistry.toSdkPluginConfig(),
        permissionMode: skipPerms ? "bypassPermissions" : "default",
        ...(skipPerms ? { allowDangerouslySkipPermissions: true } : {}),
        env: { ...process.env, ANTHROPIC_API_KEY: undefined, PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}` },
        ...(useResume && resumeSessionId ? { resume: resumeSessionId } : {}),
        ...(getConfig().CLAUDE_MODEL ? { model: getConfig().CLAUDE_MODEL } : {}),

        canUseTool: async (
          toolName: string,
          input: Record<string, unknown>,
        ) => {
          toolUseCount++;

          // Tool activity labels for Discord display
          const toolLabels: Record<string, string> = {
            Read: L("Reading files", "파일 읽는 중"),
            Glob: L("Searching files", "파일 검색 중"),
            Grep: L("Searching code", "코드 검색 중"),
            Write: L("Writing file", "파일 작성 중"),
            Edit: L("Editing file", "파일 편집 중"),
            Bash: L("Running command", "명령어 실행 중"),
            WebSearch: L("Searching web", "웹 검색 중"),
            WebFetch: L("Fetching URL", "URL 가져오는 중"),
            TodoWrite: L("Updating tasks", "작업 업데이트 중"),
          };
          const filePath = typeof input.file_path === "string"
            ? ` \`${(input.file_path as string).split(/[\\/]/).pop()}\``
            : "";
          lastActivity = `${toolLabels[toolName] ?? `Using ${toolName}`}${filePath}`;

          // Surface progress on every tool use. surfaceProgress decides
          // whether to edit the Thinking message (pre-text), update the
          // separate progress message (post-text, stale), or stay quiet
          // (post-text, fresh). This is the fix for the UI-freeze bug
          // where tool activity after first text output was invisible.
          await surfaceProgress();

          // Handle AskUserQuestion with interactive Discord UI
          if (toolName === "AskUserQuestion") {
            const questions = (input.questions as AskQuestionData[]) ?? [];
            if (questions.length === 0) {
              return { behavior: "allow" as const, updatedInput: input };
            }

            const answers: Record<string, string> = {};

            for (let qi = 0; qi < questions.length; qi++) {
              const q = questions[qi];
              const qRequestId = randomUUID();
              const { embed, components } = createAskUserQuestionEmbed(
                q,
                qRequestId,
                qi,
                questions.length,
              );

              updateSessionStatus(channelId, "waiting");
              await channel.send({ embeds: [embed], components });

              const answer = await new Promise<string | null>((resolve) => {
                const timeout = setTimeout(() => {
                  pendingQuestions.delete(qRequestId);
                  // Clean up custom input if pending
                  const ci = pendingCustomInputs.get(channelId);
                  if (ci?.requestId === qRequestId) {
                    pendingCustomInputs.delete(channelId);
                  }
                  resolve(null);
                }, 5 * 60 * 1000);

                pendingQuestions.set(qRequestId, {
                  resolve: (ans) => {
                    clearTimeout(timeout);
                    pendingQuestions.delete(qRequestId);
                    resolve(ans);
                  },
                  channelId,
                });
              });

              if (answer === null) {
                updateSessionStatus(channelId, "online");
                return {
                  behavior: "deny" as const,
                  message: L("Question timed out", "질문 시간 초과"),
                };
              }

              // AskUserQuestionOutput.answers is keyed by the full question text,
              // not the short header chip (see sdk-tools.d.ts AskUserQuestionOutput).
              answers[q.question] = answer;
            }

            updateSessionStatus(channelId, "online");
            return {
              behavior: "allow" as const,
              updatedInput: { ...input, answers },
            };
          }

          // Auto-approve read-only tools
          const readOnlyTools = ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite"];
          if (readOnlyTools.includes(toolName)) {
            return { behavior: "allow" as const, updatedInput: input };
          }

          // Check auto-approve setting
          const currentProject = getProject(channelId);
          if (currentProject?.auto_approve) {
            return { behavior: "allow" as const, updatedInput: input };
          }

          // Ask user via Discord buttons
          const requestId = randomUUID();
          const { embed, row } = createToolApprovalEmbed(
            toolName,
            input,
            requestId,
          );

          updateSessionStatus(channelId, "waiting");
          await channel.send({
            embeds: [embed],
            components: [row],
          });

          // Wait for user decision (timeout 5 min)
          return new Promise((resolve) => {
            const timeout = setTimeout(() => {
              pendingApprovals.delete(requestId);
              updateSessionStatus(channelId, "online");
              resolve({ behavior: "deny" as const, message: "Approval timed out" });
            }, 5 * 60 * 1000);

            pendingApprovals.set(requestId, {
              resolve: (decision) => {
                clearTimeout(timeout);
                pendingApprovals.delete(requestId);
                updateSessionStatus(channelId, "online");
                resolve(
                  decision.behavior === "allow"
                    ? { behavior: "allow" as const, updatedInput: input }
                    : { behavior: "deny" as const, message: decision.message ?? "Denied by user" },
                );
              },
              channelId,
            });
          });
        },
      },
    });

    let queryInstance = runQuery(Boolean(resumeSessionId));
    let attemptedResume = Boolean(resumeSessionId);

    try {
      retry: while (true) {
        // Store the active session (update each iteration so Stop button uses current instance)
        this.sessions.set(channelId, {
          queryInstance,
          channelId,
          sessionId: resumeSessionId ?? null,
          dbId,
        });

        try {
          for await (const message of queryInstance) {
            // Capture session ID
            if (
              message.type === "system" &&
              "subtype" in message &&
              message.subtype === "init"
            ) {
              const sdkSessionId = (message as { session_id?: string }).session_id;
              if (sdkSessionId) {
                const active = this.sessions.get(channelId);
                if (active) active.sessionId = sdkSessionId;
                upsertSession(dbId, channelId, sdkSessionId, "online");
              }
            }

            // Handle streaming text
            if (message.type === "assistant" && "content" in message) {
              const content = message.content;
              if (Array.isArray(content)) {
                for (const block of content) {
                  if ("text" in block && typeof block.text === "string") {
                    responseBuffer += block.text;
                    hasTextOutput = true;
                  }
                }
              }

              // Throttled message edit
              const now = Date.now();
              if (now - lastEditTime >= EDIT_INTERVAL && responseBuffer.length > 0) {
                lastEditTime = now;
                // Record that fresh text just streamed. This (a) suppresses
                // the next few progress ticks via the stale-threshold check
                // and (b) abandons any existing progress message so the next
                // stale window will create a fresh snapshot below the
                // latest streamed content rather than editing one that's
                // now above unrelated text.
                lastTextTime = now;
                progressMessage = null;
                const { tail, remainingBuffer } = await flushStreamBuffer(
                  channel,
                  currentMessage,
                  responseBuffer,
                );
                currentMessage = tail;
                responseBuffer = remainingBuffer;
              }
            }

            // Handle result. The SDK emits two flavors:
            //   - SDKResultSuccess: { type: "result", subtype: "success",
            //                         result: string, ... }
            //   - SDKResultError:   { type: "result", subtype:
            //                         "error_during_execution" | ...,
            //                         errors: string[], is_error: true, ... }
            // The previous check `"result" in message` only matched success
            // because SDKResultError has `errors[]` instead of `result`.
            // Error results then fell through, the loop kept waiting, and
            // the SDK eventually threw `Claude Code returned an error
            // result: ...` which surfaced as a bare `❌` message with no
            // cost/duration footer — exactly the symptom the user reported.
            if (message.type === "result") {
              const resultMsg = message as {
                type: "result";
                subtype?: string;
                result?: string;
                errors?: string[];
                is_error?: boolean;
                total_cost_usd?: number;
                duration_ms?: number;
              };
              const isError =
                resultMsg.is_error === true ||
                (resultMsg.subtype !== undefined && resultMsg.subtype !== "success");
              const resultText = isError
                ? (resultMsg.errors && resultMsg.errors.length > 0
                    ? resultMsg.errors.join("; ")
                    : L("Task failed", "작업 실패"))
                : (resultMsg.result ?? L("Task completed", "작업 완료"));

              // Flush remaining buffer
              if (responseBuffer.length > 0) {
                const chunks = splitMessage(responseBuffer);
                try {
                  await currentMessage.edit(chunks[0] || L("Done.", "완료."));
                  for (let i = 1; i < chunks.length; i++) {
                    await channel.send(chunks[i]);
                  }
                } catch (e) {
                  console.warn(`[flush] Failed to edit final message for ${channelId}:`, e instanceof Error ? e.message : e);
                }
              }

              // Replace stop button with completed button
              try {
                await currentMessage.edit({
                  components: [createCompletedButton()],
                });
              } catch (e) {
                console.warn(`[complete] Failed to update completed button for ${channelId}:`, e instanceof Error ? e.message : e);
              }

              // Send result embed (red + ❌ on error, green + ✅ on success)
              const resultEmbed = createResultEmbed(
                resultText,
                resultMsg.total_cost_usd ?? 0,
                resultMsg.duration_ms ?? 0,
                getConfig().SHOW_COST,
                isError,
              );
              await channel.send({
                embeds: [resultEmbed],
                components: [createFinishFeatureButton(channelId)],
              });

              // Detect auth/credit errors in result and suggest re-login
              const resultAuthKeywords = ["credit balance", "not authenticated", "unauthorized", "authentication", "login required", "auth token", "expired", "not logged in", "please run /login"];
              const lowerResult = resultText.toLowerCase();
              if (resultAuthKeywords.some((kw) => lowerResult.includes(kw))) {
                await channel.send(L(
                  "🔑 Claude Code is not logged in. Please open a terminal on the host PC and run `claude login` to authenticate, then try again.",
                  "🔑 Claude Code 로그인이 필요합니다. 호스트 PC에서 터미널을 열고 `claude login`을 실행하여 인증 후 다시 시도해 주세요.",
                ));
              }

              updateSessionStatus(channelId, isError ? "offline" : "idle");
              hasResult = true;
              // Explicitly break out of the for-await as soon as the result
              // is processed. We do NOT trust the SDK iterator to close on
              // its own — in practice (string-prompt / single-user-turn
              // mode) the SDK calls transport.endInput() after the first
              // result, but the underlying claude CLI subprocess may take
              // arbitrarily long to actually exit (flushing buffers, running
              // hooks, waiting on dangling network callbacks). If the
              // iterator stalls, this for-await blocks forever, the finally
              // block never runs, the session entry never leaves
              // this.sessions, and the user sees: no Stop button, can't
              // send new messages — the exact bug the user reported.
              break;
            }
          }
          break;
        } catch (innerError) {
          // If the resume attempt crashed before any user-visible output, the saved
          // session_id is likely stale. Silently retry once without resume.
          const rawMsg = innerError instanceof Error ? innerError.message : String(innerError);
          const resumeStale =
            attemptedResume &&
            !hasTextOutput &&
            !hasResult &&
            (rawMsg.includes("process exited with code") ||
              rawMsg.includes("No conversation found") ||
              rawMsg.includes("session not found") ||
              /resume/i.test(rawMsg));
          if (!resumeStale) throw innerError;

          console.warn(`[session] Resume failed for ${channelId}, retrying without resume:`, rawMsg);
          upsertSession(dbId, channelId, null, "online");
          queryInstance = runQuery(false);
          attemptedResume = false;
          continue retry;
        }
      }
    } catch (error) {
      // Skip error if result was already delivered (e.g., "Credit balance is too low" + exit code 1)
      if (hasResult) {
        console.warn(`[session] Ignoring post-result error for ${channelId}:`, error instanceof Error ? error.message : error);
        return;
      }
      const rawMsg =
        error instanceof Error ? error.message : "Unknown error occurred";

      // Parse API error JSON to show clean message
      let errMsg = rawMsg;
      const jsonMatch = rawMsg.match(
        /API Error: (\d+)\s*(\{.*\})/s,
      );
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[2]);
          const statusCode = jsonMatch[1];
          const message =
            parsed?.error?.message ?? parsed?.message ?? "Unknown error";
          errMsg = `API Error ${statusCode}: ${message}. Please try again later.`;
        } catch (parseErr) {
          console.warn(`[error-parse] Failed to parse API error JSON for ${channelId}:`, parseErr instanceof Error ? parseErr.message : parseErr);
          // Fall back to extracting just the status code
          errMsg = `API Error ${jsonMatch[1]}. Please try again later.`;
        }
      } else if (rawMsg.includes("process exited with code")) {
        errMsg = `${rawMsg}. The server may be temporarily unavailable — please try again later.`;
      }

      // Detect auth/credit errors and suggest re-login
      const authKeywords = ["credit balance", "not authenticated", "unauthorized", "authentication", "login required", "auth token", "expired", "not logged in", "please run /login"];
      const lowerMsg = rawMsg.toLowerCase();
      if (authKeywords.some((kw) => lowerMsg.includes(kw))) {
        errMsg += L(
          "\n\n🔑 Claude Code is not logged in. Please open a terminal on the host PC and run `claude login` to authenticate, then try again.",
          "\n\n🔑 Claude Code 로그인이 필요합니다. 호스트 PC에서 터미널을 열고 `claude login`을 실행하여 인증 후 다시 시도해 주세요.",
        );
      }

      const resultEmbed = createResultEmbed(
        errMsg,
        0,
        Date.now() - startTime,
        getConfig().SHOW_COST,
        true,
      );
      await channel.send({
        embeds: [resultEmbed],
        components: [createFinishFeatureButton(channelId)],
      });
      updateSessionStatus(channelId, "offline");
    } finally {
      clearInterval(heartbeatInterval);
      if (durationTimer) clearTimeout(durationTimer);
      // Only clear the sessions entry if it's still OURS. If stopSession()
      // (or a stale-loop watchdog) already deleted it and the user already
      // started a new send, the entry under channelId now belongs to that
      // newer invocation — wiping it here would silently break their next
      // task. Compare by dbId since that's unique per sendMessage call.
      const current = this.sessions.get(channelId);
      if (current && current.dbId === dbId) {
        this.sessions.delete(channelId);
      }

      // Strip the Stop button from any lingering progress message so the
      // user can't click it on a session that's already over. We don't
      // delete the message — its content is a useful audit trail of what
      // Claude was doing during the silent phase.
      if (progressMessage) {
        progressMessage.edit({ components: [] }).catch(() => {});
      }

      // Clean up any pending approvals/questions for this channel
      for (const [id, entry] of pendingApprovals) {
        if (entry.channelId === channelId) pendingApprovals.delete(id);
      }
      for (const [id, entry] of pendingQuestions) {
        if (entry.channelId === channelId) pendingQuestions.delete(id);
      }
      pendingCustomInputs.delete(channelId);

      // Process next queued message if any
      const queue = this.messageQueue.get(channelId);
      if (queue && queue.length > 0) {
        const next = queue.shift()!;
        if (queue.length === 0) this.messageQueue.delete(channelId);
        const remaining = queue.length;
        const preview = next.prompt.length > 40 ? next.prompt.slice(0, 40) + "…" : next.prompt;
        const msg = remaining > 0
          ? L(`📨 Processing queued message... (remaining: ${remaining})\n> ${preview}`, `📨 대기 중이던 메시지를 처리합니다... (남은 큐: ${remaining}개)\n> ${preview}`)
          : L(`📨 Processing queued message...\n> ${preview}`, `📨 대기 중이던 메시지를 처리합니다...\n> ${preview}`);
        channel.send(msg).catch(() => {});
        this.sendMessage(next.channel, next.prompt).catch((err) => {
          console.error("Queue sendMessage error:", err);
        });
      }
    }
  }

  async stopSession(channelId: string): Promise<boolean> {
    const session = this.sessions.get(channelId);
    if (!session) return false;

    // ALWAYS evict the entry from the map FIRST. This unblocks the channel
    // for new messages even if interrupt() hangs (which it can: the SDK
    // documents interrupt() as "only supported when streaming input/output
    // is used" — we pass a string prompt, so the control request can stall
    // indefinitely waiting for a response from a subprocess that's not
    // listening on the control channel). The old code awaited interrupt()
    // before deleting, so a hung interrupt left the session stuck forever.
    this.sessions.delete(channelId);

    // Fire interrupt() but don't let it block. 3s hard cap; we don't care
    // if it succeeds, we only care that we tried. The for-await loop in
    // sendMessage will exit eventually when the subprocess actually dies,
    // and its finally block will no-op the sessions.delete (see dbId guard).
    Promise.race([
      session.queryInstance.interrupt(),
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ]).catch((e) => {
      console.warn(
        `[stop] interrupt() failed for ${channelId}:`,
        e instanceof Error ? e.message : e,
      );
    });

    // Clean up any pending approvals/questions for this channel
    for (const [id, entry] of pendingApprovals) {
      if (entry.channelId === channelId) pendingApprovals.delete(id);
    }
    for (const [id, entry] of pendingQuestions) {
      if (entry.channelId === channelId) pendingQuestions.delete(id);
    }
    pendingCustomInputs.delete(channelId);

    updateSessionStatus(channelId, "offline");
    return true;
  }

  isActive(channelId: string): boolean {
    return this.sessions.has(channelId);
  }

  resolveApproval(
    requestId: string,
    decision: "approve" | "deny" | "approve-all",
  ): boolean {
    const pending = pendingApprovals.get(requestId);
    if (!pending) return false;

    if (decision === "approve-all") {
      // Enable auto-approve for this channel
      setAutoApprove(pending.channelId, true);
      pending.resolve({ behavior: "allow" });
    } else if (decision === "approve") {
      pending.resolve({ behavior: "allow" });
    } else {
      pending.resolve({ behavior: "deny", message: "Denied by user" });
    }

    return true;
  }

  resolveQuestion(requestId: string, answer: string): boolean {
    const pending = pendingQuestions.get(requestId);
    if (!pending) return false;
    pending.resolve(answer);
    return true;
  }

  enableCustomInput(requestId: string, channelId: string): void {
    pendingCustomInputs.set(channelId, { requestId });
  }

  resolveCustomInput(channelId: string, text: string): boolean {
    const ci = pendingCustomInputs.get(channelId);
    if (!ci) return false;
    pendingCustomInputs.delete(channelId);

    const pending = pendingQuestions.get(ci.requestId);
    if (!pending) return false;
    pending.resolve(text);
    return true;
  }

  hasPendingCustomInput(channelId: string): boolean {
    return pendingCustomInputs.has(channelId);
  }

  // --- Message queue ---

  setPendingQueue(channelId: string, channel: TextChannel, prompt: string): void {
    this.pendingQueuePrompts.set(channelId, { channel, prompt });
  }

  confirmQueue(channelId: string): boolean {
    const pending = this.pendingQueuePrompts.get(channelId);
    if (!pending) return false;
    this.pendingQueuePrompts.delete(channelId);
    const queue = this.messageQueue.get(channelId) ?? [];
    queue.push(pending);
    this.messageQueue.set(channelId, queue);
    return true;
  }

  cancelQueue(channelId: string): void {
    this.pendingQueuePrompts.delete(channelId);
  }

  isQueueFull(channelId: string): boolean {
    const queue = this.messageQueue.get(channelId) ?? [];
    return queue.length >= SessionManager.MAX_QUEUE_SIZE;
  }

  getQueueSize(channelId: string): number {
    return (this.messageQueue.get(channelId) ?? []).length;
  }

  hasQueue(channelId: string): boolean {
    return this.pendingQueuePrompts.has(channelId);
  }

  getQueue(channelId: string): { channel: TextChannel; prompt: string }[] {
    return this.messageQueue.get(channelId) ?? [];
  }

  clearQueue(channelId: string): number {
    const queue = this.messageQueue.get(channelId) ?? [];
    const count = queue.length;
    this.messageQueue.delete(channelId);
    this.pendingQueuePrompts.delete(channelId);
    return count;
  }

  removeFromQueue(channelId: string, index: number): string | null {
    const queue = this.messageQueue.get(channelId);
    if (!queue || index < 0 || index >= queue.length) return null;
    const [removed] = queue.splice(index, 1);
    if (queue.length === 0) {
      this.messageQueue.delete(channelId);
      this.pendingQueuePrompts.delete(channelId);
    }
    return removed.prompt;
  }
}

export const sessionManager = new SessionManager();
