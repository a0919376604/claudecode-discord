# R-003 DeepTutor Tutor Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a registered Discord channel become a goal-driven tutor backed by DeepTutor's `mastery_path` capability, configured with `/tutor`, pushed daily/weekly through the existing cron scheduler.

**Architecture:** A new `DeepTutorBackend` implements the existing `AgentBackend` interface by spawning `deeptutor run mastery_path … --format json` and translating its NDJSON `StreamEvent`s into `NormalizedEvent`s via a pure translator. A `tutors` table holds per-channel tutor config and the DeepTutor session id (the learning-path key), independent of the generic `sessions` table. `/tutor setup` writes the tutor row, switches the channel's backend to `deeptutor`, (re)creates two `crons` rows (daily + weekly) with UTC cron expressions, and kicks off the intake turn.

**Tech Stack:** TypeScript (ESM), discord.js v14, better-sqlite3, vitest, cron-parser (already a dependency). No new dependencies.

**Spec:** `docs/specs/R-003-add-deeptutor-tutor-backend.md` — read it first, especially `## Seams` and `## Decisions`.

## Global Constraints

- No new npm dependencies. Use `node:child_process`, `node:readline`, `Intl.DateTimeFormat`.
- `Project.backend` becomes `"claude" | "codex" | "deeptutor"`; existing Claude/Codex behavior must not change (all existing tests stay green).
- `cron/parser.ts` is NOT modified; tutor cron expressions are UTC, computed at `/tutor setup`.
- DeepTutor invocation: `<DEEPTUTOR_BIN> run mastery_path <prompt> [--session <id>] --format json -l <language>`; `DEEPTUTOR_BIN` env var, optional, default `deeptutor`.
- First DeepTutor call must NOT pass `--session` (DeepTutor rejects unknown ids with `Conversation not found`).
- Never auto-create a new DeepTutor session after a stale-session error; only `/tutor reset` clears `tutors.deeptutor_session_id`.
- Cron rows created by `/tutor` use `name` `tutor:daily` / `tutor:weekly`; `/tutor` only ever deletes rows with those names for its channel.
- User-facing strings via `L(en, kr)` from `src/utils/i18n.ts`. Tutor prompts sent to DeepTutor are plain strings (not i18n'd).
- Tests: scoped runs only, e.g. `npx vitest run src/db/tutors.test.ts`. Type check: `npx tsc --noEmit`.

## Review Focus

1. `deeptutor` binary missing (spawn `ENOENT`) → the turn ends with one error `result` whose text says DeepTutor is not installed; `getAuthErrorHint` returns an install hint; no hang. (Task 3 test `missing binary`.)
2. Stale DeepTutor session (`Conversation not found` on stderr/stdout) → error `result` telling the user to run `/tutor reset`; `tutors.deeptutor_session_id` unchanged; `isResumeStaleError` false. (Task 3 test `stale session`.)
3. `/tutor setup` run twice on the same channel → exactly one `tutor:daily` and one `tutor:weekly` cron; existing non-tutor crons untouched; existing `deeptutor_session_id` preserved. (Task 6 test `setup is idempotent`.)
4. Local push time that crosses midnight into the previous UTC day (`07:00` Asia/Taipei → `0 23 * * *`; weekly Sunday → Saturday `0 23 * * 6`). (Task 5 tests.)
5. Child stdout with non-JSON lines (log noise) or a line split across chunks → ignored / reassembled, stream continues. (Task 3 test `noisy stdout`.)

---

### Task 1: `tutors` table, CRUD, and the `deeptutor` backend value

**Files:**
- Modify: `src/db/types.ts` (Project.backend union; add `Tutor` interface)
- Modify: `src/db/database.ts` (`CREATE TABLE IF NOT EXISTS tutors` in `initDatabase`; widen `setBackend` param type)
- Create: `src/db/tutors.ts`
- Test: `src/db/tutors.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/db/types.ts
  export type BackendName = "claude" | "codex" | "deeptutor";   // Project.backend: BackendName
  export interface Tutor {
    channel_id: string; subject: string; goal: string;
    level: string | null; deadline: string | null; daily_minutes: number | null;
    menu: string | null; push_time: string;      // "HH:MM" local
    timezone: string; language: string;           // e.g. "Asia/Taipei", "zh"
    deeptutor_session_id: string | null; created_at: number;
  }
  // src/db/tutors.ts  (same __setDbForTests pattern as src/db/crons.ts)
  export function __setDbForTests(db: Database.Database | null): void;
  export function getTutor(channelId: string): Tutor | undefined;
  export function upsertTutor(row: Omit<Tutor, "deeptutor_session_id" | "created_at">): void; // preserves existing deeptutor_session_id + created_at
  export function setTutorSession(channelId: string, sessionId: string | null): void;
  export function deleteTutor(channelId: string): void;
  ```
- Table: `tutors(channel_id TEXT PRIMARY KEY REFERENCES projects(channel_id) ON DELETE CASCADE, subject TEXT NOT NULL, goal TEXT NOT NULL, level TEXT, deadline TEXT, daily_minutes INTEGER, menu TEXT, push_time TEXT NOT NULL, timezone TEXT NOT NULL, language TEXT NOT NULL, deeptutor_session_id TEXT, created_at INTEGER NOT NULL)`.

- [x] **Step 1: Write failing tests** in `src/db/tutors.test.ts` using an in-memory DB that has a `projects` table with row `ch1` (copy the `:memory:` + `__setDbForTests` setup style of `src/db/crons.test.ts`; create the `tutors` table with the exact DDL above):
  - `upsertTutor then getTutor round-trips all fields; deeptutor_session_id is null`
  - `upsertTutor on existing row keeps deeptutor_session_id and created_at` (setTutorSession("ch1","s-1") → upsert with new goal → `getTutor("ch1")!.deeptutor_session_id === "s-1"` and goal updated)
  - `setTutorSession(ch, null) clears the id`
  - `deleteTutor removes the row`; `getTutor("missing") === undefined`
- [x] **Step 2:** `npx vitest run src/db/tutors.test.ts` → FAIL (module not found).
- [x] **Step 3:** Implement `src/db/tutors.ts` (use `INSERT … ON CONFLICT(channel_id) DO UPDATE SET` excluding `deeptutor_session_id`, `created_at`); add the DDL to `initDatabase` in `src/db/database.ts`; change `Project.backend` to `BackendName` and `setBackend(channelId, backend: BackendName)`.
- [x] **Step 4:** `npx vitest run src/db/tutors.test.ts src/db/database.test.ts && npx tsc --noEmit` → PASS / no errors.
- [x] **Step 5:** Commit `feat(R-003): tutors table and deeptutor backend value`.

### Task 2: DeepTutor NDJSON → NormalizedEvent translator

**Files:**
- Create: `src/agent/deeptutor-translate.ts`
- Test: `src/agent/deeptutor-translate.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function translateDeepTutorEvent(ev: unknown): NormalizedEvent[];
  export function formatQuestionCard(card: unknown): string | null; // null when not a valid card
  ```
- Input shape (DeepTutor `StreamEvent.to_dict()`): `{ type, source, stage, content, metadata, session_id, turn_id, seq, timestamp }`.
- Mapping (from spec Seams):
  (Verified in DeepTutor `deeptutor/runtime/stream_bus.py:241-276`, `runtime/agentic/tool_dispatch.py:880-905`, `agents/loop/pipeline.py:1690-1705`:
  `tool_call` carries the tool name in `content` and args in `metadata.args`; `tool_result` carries result text in `content`, tool name in `metadata.tool`,
  and the tool's public metadata in `metadata.tool_metadata`; a terminator tool's final `content` event may also carry `metadata.tool_metadata`.)
  - `content` → `[{type:"text_delta", text: content}]` (skip empty content)
  - `session` → `[{type:"session_init", sessionId: metadata.session_id || session_id}]` (skip if both empty)
  - `tool_call` → `[{type:"tool_start", toolName: content || "tool", input: metadata.args ?? {}}]`
  - `tool_result` → `[{type:"tool_end", toolName: metadata.tool || "tool", ok: metadata.success !== false}]`
  - For `content` and `tool_result` events: if `metadata.tool_metadata.mastery_question` is a valid card, append `{type:"text_delta", text: formatQuestionCard(card)}` after the mapped event(s). (The backend drops a card text identical to one already yielded in the same run — the same card can arrive on both events.)
  - `error` → `[{type:"result", text: content || "DeepTutor error", isError:true}]`
  - `result`, `done` → `[{type:"result", text: content ?? "", isError:false}]`
  - anything else / non-object → `[]`
- `formatQuestionCard` output (exact layout): first line `📝 ` + `prompt`; if `objective.name` non-empty append line `🎯 <name>`; for each option a line `<label>. <body>`; last line `↩️ 直接在頻道回覆你的答案` . Must never read `expected_answer` / `explanation`.

- [ ] **Step 1: Write failing tests** (`src/agent/deeptutor-translate.test.ts`):
  - `content → text_delta`: `{type:"content",content:"hi"}` → `[{type:"text_delta",text:"hi"}]`
  - `session → session_init from metadata`: `{type:"session",metadata:{session_id:"s1"}}` → `[{type:"session_init",sessionId:"s1"}]`
  - `tool_result with card emits tool_end then card text`: metadata `{tool:"mastery_quiz", tool_metadata:{mastery_question:{prompt:"Pick the synonym of big", objective:{id:"k1",name:"Vocab"}, options:[{label:"A",body:"large"},{label:"B",body:"tiny"}], expected_answer:"A"}}}` → second event text contains `"A. large"`, `"B. tiny"`, `"Pick the synonym of big"` and does NOT contain `"expected"`
  - `tool_call → tool_start`: `{type:"tool_call",content:"mastery_status",metadata:{args:{a:1}}}` → `[{type:"tool_start",toolName:"mastery_status",input:{a:1}}]`
  - `content with card metadata emits text then card text`
  - `error → isError result`; `done → result not error`; `unknown type → []`; `null → []`
- [ ] **Step 2:** `npx vitest run src/agent/deeptutor-translate.test.ts` → FAIL.
- [ ] **Step 3:** Implement both functions.
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5:** Commit `feat(R-003): DeepTutor event translator`.

### Task 3: `DeepTutorBackend` + factory + config

**Files:**
- Create: `src/agent/deeptutor-backend.ts`
- Modify: `src/agent/backend-factory.ts` (return `new DeepTutorBackend()` when `project.backend === "deeptutor"`)
- Modify: `src/utils/config.ts` (optional `DEEPTUTOR_BIN`, default `"deeptutor"`)
- Test: `src/agent/deeptutor-backend.test.ts`

**Interfaces:**
- Consumes: `translateDeepTutorEvent` (Task 2); `getTutor`, `setTutorSession` (Task 1); `getConfig().DEEPTUTOR_BIN`.
- Produces: `export class DeepTutorBackend implements AgentBackend`.
- Behavior:
  - `start(opts)`: `tutor = getTutor(opts.channelId)`. If missing → yield one `result{isError:true, text: "No tutor configured for this channel — run /tutor setup"}` and return. Args: `["run","mastery_path", opts.prompt, ...(tutor.deeptutor_session_id ? ["--session", id] : []), "--format","json","-l", tutor.language]`, `spawn(bin, args, {cwd: opts.cwd, stdio:["ignore","pipe","pipe"]})`. **Ignore `opts.resumeSessionId`.**
  - Read stdout with `readline` line by line; `JSON.parse` failures are skipped. Each parsed object → `translateDeepTutorEvent`. Track the first non-empty `session_id` seen (from a `session_init` or any event's top-level `session_id`): if the tutor row had no session id, call `setTutorSession(channelId, id)`; yield exactly one `session_init` per run.
  - Yield at most one `result`; after it, stop reading and kill the child if still running.
  - Collect stderr (cap 8 KB). On child exit with no `result` yielded: yield `result{isError:true, text}` where text = stale message if stdout+stderr matches `/Conversation not found/i` (`"This tutor's DeepTutor session is gone — run /tutor reset to start a new learning path."`), else last stderr lines or `"DeepTutor exited with code <n>"`.
  - Spawn `error` event with `code === "ENOENT"` → `result{isError:true, text:"DeepTutor CLI not found (DEEPTUTOR_BIN=<bin>)."}`.
  - `interrupt()`: kill child (`SIGTERM`). `respondToApproval`/`respondToQuestion`: no-op. `isResumeStaleError`: `false`. `getAuthErrorHint(err)`: if message matches `/not found \(DEEPTUTOR_BIN|ENOENT/` → install hint mentioning `pip install -e .` in the DeepTutor checkout; if matches `/api key|provider|llm/i` → hint to configure the DeepTutor LLM provider; else `null`.

- [ ] **Step 1: Write failing tests** in `src/agent/deeptutor-backend.test.ts` — mock `node:child_process` `spawn` (pattern: `src/agent/codex-backend-lifecycle.test.ts` with `PassThrough` stdout/stderr and an `EventEmitter` proc), mock `../db/tutors.js` (`getTutor`, `setTutorSession`), mock `../utils/config.js` `getConfig` → `{ DEEPTUTOR_BIN: "deeptutor" }`. Tests:
  - `first run omits --session and stores the new session id`: tutor with `deeptutor_session_id:null`; stdout lines `{"type":"session","metadata":{"session_id":"s9"},"session_id":"s9"}`, `{"type":"content","content":"Hello","session_id":"s9"}`, `{"type":"done","session_id":"s9"}` → spawn args don't include `--session`; events `[session_init s9, text_delta Hello, result ok]`; `setTutorSession("ch","s9")` called once.
  - `resumes with stored session id and ignores opts.resumeSessionId`: tutor id `s1`, `opts.resumeSessionId:"other"` → args contain `["--session","s1"]`.
  - `noisy stdout`: a non-JSON line and a JSON line split across two `write`s → still yields the content event.
  - `stale session`: stderr `Conversation not found`, exit 1, no result → one error result containing `/tutor reset`; `setTutorSession` not called; `backend.isResumeStaleError(new Error("Conversation not found")) === false`.
  - `missing binary`: proc emits `error` with `Object.assign(new Error("spawn deeptutor ENOENT"),{code:"ENOENT"})` → one error result containing `DeepTutor CLI not found`; `getAuthErrorHint(new Error(thatText))` non-null.
  - `no tutor row` → single error result mentioning `/tutor setup`, spawn not called.
  - `only one result even if both result and done arrive`.
  - `duplicate question card text is yielded once` (same card on a `tool_result` and a later `content` event).
- [ ] **Step 2:** `npx vitest run src/agent/deeptutor-backend.test.ts` → FAIL.
- [ ] **Step 3:** Implement; wire factory and config.
- [ ] **Step 4:** `npx vitest run src/agent/deeptutor-backend.test.ts src/utils/config.test.ts src/utils/config-env.test.ts && npx tsc --noEmit` → PASS.
- [ ] **Step 5:** Commit `feat(R-003): DeepTutor agent backend`.

### Task 4: Session-manager & switch-backend awareness of `deeptutor`

**Files:**
- Modify: `src/claude/session-manager.ts` (`runBackend` model/effort at ~409-410; `wakeUp` at ~898-916; model-change label at ~443-444)
- Modify: `src/bot/commands/switch-backend.ts:55` (`currentDisplay` handles `deeptutor` → `"DeepTutor"`)
- Test: `src/claude/session-manager.test.ts`, `src/bot/commands/switch-backend.test.ts`

**Interfaces:**
- `wakeUp(channel, prompt, source)`: when `getProject(channel.id)?.backend === "deeptutor"` → `this.sendMessage(channel, prompt)` (no preamble); otherwise unchanged.
- `runBackend`: for `deeptutor` pass `model: undefined, effort: undefined`.

- [ ] **Step 1: Write failing tests:**
  - in `session-manager.test.ts` `describe("SessionManager.wakeUp")`: `deeptutor channel gets the raw prompt without preamble` — mock `getProject` to return `{backend:"deeptutor", …}`; expect `calls[0].prompt === "daily push"` exactly. (Existing two wakeUp tests must keep passing — make sure their `getProject` mock returns a claude project or undefined.)
  - in `switch-backend.test.ts`: `switching from deeptutor names DeepTutor in the warning` — project `{backend:"deeptutor"}`, `/claude` → `editReply` content contains `"DeepTutor"`.
- [ ] **Step 2:** `npx vitest run src/claude/session-manager.test.ts src/bot/commands/switch-backend.test.ts` → FAIL on the new tests.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npx vitest run src/claude/session-manager.test.ts src/claude/session-manager-integration.test.ts src/bot/commands/switch-backend.test.ts && npx tsc --noEmit` → PASS.
- [ ] **Step 5:** Commit `feat(R-003): session manager handles deeptutor backend`.

### Task 5: Tutor time conversion and prompts

**Files:**
- Create: `src/tutor/schedule.ts`
- Create: `src/tutor/prompts.ts`
- Test: `src/tutor/schedule.test.ts`, `src/tutor/prompts.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // schedule.ts
  export function localTimeToUtcCron(hhmm: string, timeZone: string, dayOfWeek?: number, now?: Date): string;
  // hhmm "HH:MM" 24h; dayOfWeek 0=Sun..6=Sat in LOCAL time; returns "M H * * *" or "M H * * D" in UTC.
  // Throws Error("invalid time") / Error("invalid timezone") on bad input.
  // Offset = the zone's current UTC offset at `now` (default new Date()), via Intl.DateTimeFormat timeZoneName:"longOffset".
  // ponytail: offset frozen at setup time — DST zones drift 1h after a switch; upgrade = tz column on crons + tz-aware nextFireAfter.
  // prompts.ts
  export function buildIntakePrompt(t: Tutor): string;
  export function buildDailyPrompt(t: Tutor): string;
  export function buildWeeklyPrompt(t: Tutor): string;
  ```
- Prompt requirements (wording is the implementer's; tests pin these substrings/intent):
  - Intake: includes subject, goal, and level/deadline/daily_minutes/menu when present; instructs: record these with `mastery_profile`; design the outline with `mastery_build` shaped by the menu preferences; then start a short placement check; **"do not use ask_user"**; ask any clarification as plain text and wait for the next message.
  - Daily: instructs: call `mastery_status`; prioritize due reviews and weak points; **also advance at least one step toward the next goal objective**; if stuck on one weak point for days, change the teaching approach or `mastery_defer_objective`; keep it to about `daily_minutes` (default 15) minutes and mobile-friendly; menu is a preference, not a fixed list; end with one question via `mastery_quiz`; do not use ask_user.
  - Weekly: short mixed quiz of this week's material + progress report toward `goal`, any score estimate explicitly labelled as a rough estimate (`粗估`); do not use ask_user.

- [ ] **Step 1: Write failing tests:**
  - `schedule.test.ts` (pass a fixed `now`):
    - `localTimeToUtcCron("08:00","Asia/Taipei")` → `"0 0 * * *"`
    - `localTimeToUtcCron("07:00","Asia/Taipei")` → `"0 23 * * *"`
    - `localTimeToUtcCron("07:00","Asia/Taipei",0)` → `"0 23 * * 6"` (Sunday local → Saturday UTC)
    - `localTimeToUtcCron("08:30","UTC",0)` → `"30 8 * * 0"`
    - `localTimeToUtcCron("23:30","America/New_York",6, new Date("2026-01-15T12:00:00Z"))` → `"30 4 * * 0"` (EST −5, Saturday → Sunday)
    - `"25:00"` throws `invalid time`; `"Mars/Base"` throws `invalid timezone`
  - `prompts.test.ts`: for a sample Tutor: intake contains goal, `mastery_profile`, `ask_user`; daily contains `mastery_status`, `mastery_quiz` and a phrase about advancing toward the goal; weekly contains `粗估` and the goal.
- [ ] **Step 2:** `npx vitest run src/tutor/schedule.test.ts src/tutor/prompts.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5:** Commit `feat(R-003): tutor schedule conversion and prompts`.

### Task 6: `/tutor` slash command

**Files:**
- Create: `src/bot/commands/tutor.ts`
- Modify: `src/bot/client.ts` (import `* as tutorCmd`, add to `commands` array)
- Test: `src/bot/commands/tutor.test.ts`

**Interfaces:**
- Consumes: Task 1 (`getTutor`, `upsertTutor`, `setTutorSession`, `deleteTutor`), `getProject`, `setBackend`, `clearSessionId` (`src/db/database.js`); `insertCron`, `listCronsByChannel`, `deleteCronById`, `countCronsByChannel` (`src/db/crons.js`); `nextFireAfter` (`src/cron/parser.js`); Task 5; `sessionManager.isActive`, `sessionManager.sendMessage`.
- Produces: `export const data: SlashCommandBuilder`; `export async function execute(interaction): Promise<void>`.
- Subcommands:
  - `setup` — options: `subject` (req), `goal` (req), `level`, `deadline`, `daily_minutes` (integer 5–120), `menu`, `time` (default `"08:00"`), `timezone` (default `"Asia/Taipei"`), `language` (default `"zh"`). Flow: no project → error reply `/register` first; session active → error reply `/stop` first; validate time/timezone via `localTimeToUtcCron` (error reply on throw); refuse if `countCronsByChannel` − existing tutor crons + 2 > 50; `upsertTutor`; if backend ≠ deeptutor → `clearSessionId` + `setBackend(ch,"deeptutor")`; delete this channel's crons named `tutor:daily`/`tutor:weekly`; insert daily (`localTimeToUtcCron(time,tz)`) and weekly (`localTimeToUtcCron(time,tz,0)`) rows with `id: randomUUID()`, `prompt: buildDailyPrompt/buildWeeklyPrompt(tutor)`, `next_fire: nextFireAfter(expr, Date.now())`, `last_fire: null`, `created_at: Date.now()`; reply with an embed summarizing subject/goal/time/timezone; then, only if the tutor has no `deeptutor_session_id`, `void sessionManager.sendMessage(channel, buildIntakePrompt(tutor))`.
  - `show` — reply with current tutor config + next fire times of its two crons, or "no tutor" message.
  - `pause` — delete only `tutor:*` crons for the channel; reply. (Re-run `setup` to resume.)
  - `reset` — `setTutorSession(ch, null)`; reply that the next message starts a new learning path.

- [ ] **Step 1: Write failing tests** in `src/bot/commands/tutor.test.ts` (mock `../../db/database.js`, `../../db/tutors.js`, `../../db/crons.js`, `../../claude/session-manager.js`, like `switch-backend.test.ts`; build an interaction stub with `options.getSubcommand/getString/getInteger`, `channelId`, `channel`, `editReply`):
  - `setup on unregistered channel replies with /register hint and writes nothing`
  - `setup creates tutor, switches backend, inserts tutor:daily "0 0 * * *" and tutor:weekly "0 0 * * 0" for 08:00 Asia/Taipei, and sends intake prompt`
  - `setup is idempotent`: existing crons `[tutor:daily, tutor:weekly, other]` → `deleteCronById` called for the two tutor ids only; `insertCron` called twice; tutor already has `deeptutor_session_id` → `sendMessage` NOT called; `setBackend` not called when already deeptutor
  - `setup with invalid time replies with error and writes nothing`
  - `pause deletes only tutor crons`
  - `reset clears the DeepTutor session id`
- [ ] **Step 2:** `npx vitest run src/bot/commands/tutor.test.ts` → FAIL.
- [ ] **Step 3:** Implement and register in `client.ts`.
- [ ] **Step 4:** `npx vitest run src/bot/commands/tutor.test.ts && npx tsc --noEmit && npx vitest run` → all PASS (full suite once here, it runs in ~3 s with no external credentials).
- [ ] **Step 5:** Commit `feat(R-003): /tutor command`.

## Execution log

Deviation: Task 1 widened findSessionFile’s backend parameter to BackendName — TypeScript rejected both existing interaction.ts callers after Project.backend gained deeptutor; this only updates the backend type allow-list and leaves existing lookup behavior unchanged.
