# R-003 Review Fix (attempt 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [x]`) syntax.

**Goal:** Fix the review-attempt-1 findings in the DeepTutor tutor backend without changing any spec Decision.

**Spec:** `docs/specs/R-003-add-deeptutor-tutor-backend.md`. Main plan: `docs/plans/R-003-add-deeptutor-tutor-backend.md` (tasks 1–6 are done; do not redo them).

## Global Constraints

- No new dependencies. Do not amend; one commit per task, message given per task, each ending with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Tests scoped per task; full `npx vitest run` + `npx tsc --noEmit` once at the end.
- Verified facts (do not re-investigate): DeepTutor persists the assistant message AFTER the engine loop ends and only then emits `done` (`/Users/leric/Desktop/code/DeepTutor/deeptutor/services/session/turns/executor.py:1078-1240`); post-`done` work (title generation) may still run (`:1314`). The `result` event's `content` is empty. Click parses a leading-`-` positional as an option unless preceded by `--`.

---

### Task 1: Don't kill DeepTutor on a normal finish; end the turn on `done` (BLOCKING)

**Files:** Modify `src/agent/deeptutor-backend.ts`, `src/agent/deeptutor-translate.ts` (only if needed); Test `src/agent/deeptutor-backend.test.ts`, `src/agent/deeptutor-translate.test.ts`.

**Behavior:**
- A DeepTutor `result` event no longer ends the turn and yields no `NormalizedEvent` (change the translator mapping: `result` → `[]`; `done` → `result{isError:false, text: content ?? ""}`; `error` unchanged).
- On the translated `result` (from `done` or `error`): yield it, stop reading, and do **not** signal the child; let it exit on its own (call `child.unref()` and remove the stdout/stderr listeners or `destroy()` the readline only — never `kill`).
- The `finally` cleanup kills the child only when the run did not reach a normal `done` (consumer abandoned the iterator, or `interrupt()` was called). `interrupt()` still sends `SIGTERM`.
- If the child exits without `done`, keep the existing error-result path.

- [x] **Step 1:** Rewrite test `only one result even if both result and done arrive` → `normal finish yields one result on done and never kills the child`: stdout lines `{"type":"content","content":"Hi"}`, `{"type":"result","content":""}`, `{"type":"done"}` → events end with exactly one `result{isError:false}`; `expect(proc.kill).not.toHaveBeenCalled()`. Update translator tests: `result → []`, `done → result not error`. Add `interrupt still sends SIGTERM` if not already covered.
- [x] **Step 2:** `npx vitest run src/agent/deeptutor-backend.test.ts src/agent/deeptutor-translate.test.ts` → FAIL on the changed tests.
- [x] **Step 3:** Implement.
- [x] **Step 4:** Same command → PASS.
- [x] **Step 5:** Commit `fix(R-003): end DeepTutor turns on done without killing the CLI`.

### Task 2: Pass the prompt after `--`; stale check only on stderr / non-JSON lines

**Files:** Modify `src/agent/deeptutor-backend.ts`; Test `src/agent/deeptutor-backend.test.ts`.

**Behavior:**
- Args order: `["run", "mastery_path", "--format", "json", "-l", tutor.language, ...(sessionId ? ["--session", sessionId] : []), "--", opts.prompt]`.
- `/Conversation not found/i` is tested only against stderr text and stdout lines that fail `JSON.parse`; never against parsed NDJSON events.

- [x] **Step 1:** Tests: `prompt starting with "-" is passed after --` (prompt `"-3"` → `args.slice(-2)` equals `["--","-3"]` and `--session`/`--format` appear before `--`); update `resumes with stored session id…` assertions to the new order; `reply text containing "conversation not found" is not treated as stale` (stdout `{"type":"content","content":"Error: Conversation not found means…"}` then `{"type":"done"}` → final result `isError:false`).
- [x] **Step 2:** Run `npx vitest run src/agent/deeptutor-backend.test.ts` → FAIL.
- [x] **Step 3:** Implement.
- [x] **Step 4:** Same → PASS.
- [x] **Step 5:** Commit `fix(R-003): safe DeepTutor CLI args and stale-session detection`.

### Task 3: Stop tutor pushes when the channel leaves the deeptutor backend

**Files:** Modify `src/bot/handlers/interaction.ts` (switch-backend "yes" branch, where `setBackend` is called); reuse the tutor-cron deletion from `src/bot/commands/tutor.ts` by exporting `deleteTutorCrons(channelId: string): number` from `src/bot/commands/tutor.ts` (move the existing loop that deletes `tutor:daily` / `tutor:weekly` into it; `pause` and `setup` call it). Test `src/bot/commands/tutor.test.ts` and the existing interaction/switch tests file that covers the switch buttons (`src/bot/handlers/session-controls.test.ts` or the nearest existing test of `switch-` customIds; if none exercises the yes-branch, add `src/bot/handlers/switch-confirm.test.ts`).

**Behavior:** when the confirmed switch target is `claude` or `codex` and the project's previous backend was `deeptutor`, call `deleteTutorCrons(channelId)`. The `tutors` row is kept (spec Decision). The confirmation reply mentions that tutor pushes are paused and `/tutor setup` resumes them.

- [ ] **Step 1:** Tests: `deleteTutorCrons deletes only tutor:* rows and returns the count`; `confirming /claude on a deeptutor channel deletes tutor crons and keeps the tutor row`; `confirming /codex on a claude channel does not touch crons`.
- [ ] **Step 2:** Run the touched test files → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same → PASS.
- [ ] **Step 5:** Commit `fix(R-003): pause tutor pushes when switching away from deeptutor`.

### Task 4: Small copy fixes

**Files:** `src/agent/deeptutor-translate.ts`, `src/bot/commands/tutor.ts`; their tests.

- `formatQuestionCard` last line: `L("↩️ Reply with your answer in this channel", "↩️ 이 채널에 답을 입력하세요")` — English in the first slot, Korean second (the `L(en, kr)` convention). Update any test asserting the old Chinese string.
- `/tutor reset` reply also tells the user to run `/tutor setup` to give the new learning path its goal and profile (English + Korean via `L`).

- [ ] **Step 1:** Adjust/add tests (`card footer uses the English slot`; `reset reply mentions /tutor setup`).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** `npx tsc --noEmit && npx vitest run` → all PASS.
- [ ] **Step 6:** Commit `fix(R-003): tutor copy follows L(en, kr)`.

## Execution log

- Task 1: RED confirmed (5 failures: premature result translation, no-done success, and child termination); GREEN: 35/35 scoped tests. Existing interrupt test and new iterator-abandonment test pass. Explicit error events also finish without signalling the child, as required by the terminal-event behavior.
- Task 2: RED confirmed (4 failures: argument ordering and parsed-reply false stale detection); GREEN: 16/16 backend tests. Prompt is after `--`; stale detection remains active on stderr and non-JSON stdout only.
