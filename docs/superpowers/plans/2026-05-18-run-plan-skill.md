# `/run-plan` Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a user-global `/run-plan` skill that supervises `codex exec` running an entire markdown plan file, then reports a `✅/⬜/❌` completion list — and nothing else.

**Architecture:** A single SKILL.md file at `~/.claude/skills/run-plan/SKILL.md`. The skill contains a HARD-GATE that restricts Claude to exactly: `Bash(resolve path) → Read plan → Bash(codex exec, run_in_background) → wait for completion notification → Bash(get exit code + stderr) → Read plan → report → END`. Codex updates `- [ ]` checkboxes to `- [x]` as it completes each task, giving us free resume support.

**Tech Stack:** Markdown skill file. Tools used at runtime: Read, Bash (with `run_in_background`). External CLI: `codex exec`. Note: Monitor is NOT used — for single-event waits the Bash completion notification is the correct primitive.

**Spec:** `docs/superpowers/specs/2026-05-18-run-plan-skill-design.md`

---

## File Structure

| Path | Role |
|---|---|
| `~/.claude/skills/run-plan/SKILL.md` | The skill itself — all logic lives here |
| `~/.claude/skills/run-plan/fixtures/sample-plan.md` | Tiny test plan with 3 checkboxes, used for integration testing |
| `~/.claude/skills/run-plan/fixtures/expected-after.md` | What `sample-plan.md` should look like after a successful run |
| `docs/superpowers/specs/2026-05-18-run-plan-skill-design.md` | Spec (already exists) |
| `docs/superpowers/plans/2026-05-18-run-plan-skill.md` | This plan |

No source files in the discord project itself are modified. The implementation is entirely a global skill.

---

## Task 1: Verify codex CLI prerequisites

**Files:**
- Read only — no files modified

- [ ] **Step 1: Check codex CLI is installed**

Run:
```bash
which codex && codex --version
```
Expected: prints path (e.g. `/usr/local/bin/codex`) and a version string.

If `codex not found`, **stop here** and report to user:
```
codex CLI not installed. Install from https://github.com/openai/codex first.
```
The skill is useless without codex.

- [ ] **Step 2: Confirm `codex exec` subcommand exists and document flags**

Run:
```bash
codex exec --help 2>&1 | head -60
```
Expected: a help page listing flags. Record exact flag names for:
- Working directory (e.g. `-C <path>`)
- Sandbox/write mode (e.g. `-s workspace-write`)
- Model reasoning effort (e.g. `-c 'model_reasoning_effort="high"'`)
- Non-interactive (likely default for `exec`)

Write these into a scratch note. The next tasks reference them.

- [ ] **Step 3: Smoke test codex exec with a trivial prompt**

Run (in a throwaway directory):
```bash
mkdir -p /tmp/run-plan-smoke && cd /tmp/run-plan-smoke
echo "- [ ] write hello.txt with content 'hi'" > plan.md
codex exec "Read plan.md. Do every unchecked task. After each one, change its `- [ ]` to `- [x]` in plan.md." -C /tmp/run-plan-smoke -s workspace-write
cat plan.md
```
Expected: `plan.md` shows `- [x] write hello.txt with content 'hi'` and `hello.txt` exists with content `hi`.

If this fails, debug codex setup before continuing. The whole skill depends on this behavior working.

---

## Task 2: Create skill directory and frontmatter

**Files:**
- Create: `~/.claude/skills/run-plan/SKILL.md`
- Create: `~/.claude/skills/run-plan/fixtures/` (directory)

- [ ] **Step 1: Create the directory**

Run:
```bash
mkdir -p ~/.claude/skills/run-plan/fixtures
```

- [ ] **Step 2: Write SKILL.md frontmatter and title**

Create `~/.claude/skills/run-plan/SKILL.md` with this exact content:

```markdown
---
name: run-plan
description: |
  Supervise codex exec running an entire markdown plan file, then report a
  completion checklist. Use when asked to "run this plan", "execute plan",
  "跑這個 plan", "執行 plan", or given a path to a plan/xxplan.md file with
  `- [ ]` checkbox tasks. The skill is a thin supervisor: Claude reads the plan,
  invokes codex once with the whole plan, waits silently, then reports
  ✅/⬜/❌ per task — and nothing else.
allowed-tools:
  - Read
  - Bash
  - Monitor
---

# Run Plan

Supervise codex executing an entire plan file. Report completion list at the end. Nothing else.
```

- [ ] **Step 3: Verify file readable**

Run:
```bash
cat ~/.claude/skills/run-plan/SKILL.md
```
Expected: shows the frontmatter and title above.

- [ ] **Step 4: Commit (in the discord project repo, plan + spec only — skill itself is global, not in git)**

Skip — nothing in this repo changed yet. Defer commit to after Task 7.

---

## Task 3: Write the HARD-GATE section

**Files:**
- Modify: `~/.claude/skills/run-plan/SKILL.md` (append below the title)

- [ ] **Step 1: Append HARD-GATE block**

Append this exact block to the end of `~/.claude/skills/run-plan/SKILL.md`:

```markdown

<HARD-GATE>
The ONLY legal tool sequence in this skill is:

  1. Read(plan.md)                    — see what tasks exist
  2. Bash(codex exec ...)             — run_in_background: true
  3. Monitor(shell_id)                — wait silently for codex to exit
  4. Read(plan.md)                    — see which checkboxes got ticked
  5. ONE final report message         — using the format below
  6. END

Any tool call or text message outside this sequence is a violation. Specifically forbidden:

- Sending ANY message to the user before codex finishes (no "starting...", no "this may take a while...", no progress narration)
- Saying "let me confirm..." / "should I continue?" / "I noticed..." / "looks like..."
- Using Edit, Write, Glob, Grep, or AskUserQuestion at any point
- Doing any task yourself — codex executes, you only watch
- Explaining what codex is doing, commenting on the plan's design, or suggesting improvements
- Adding any sentence to the final report beyond the formats specified

If codex exec exits non-zero or Monitor reports failure, the ONLY allowed response is the failure format below. Do not try to debug, propose fallbacks, or do tasks yourself.
</HARD-GATE>
```

- [ ] **Step 2: Verify**

Run:
```bash
grep -c "HARD-GATE" ~/.claude/skills/run-plan/SKILL.md
```
Expected: `2` (open + close tags).

---

## Task 4: Write the execution flow section

**Files:**
- Modify: `~/.claude/skills/run-plan/SKILL.md` (append)

- [ ] **Step 1: Append the Execution section**

Append to `~/.claude/skills/run-plan/SKILL.md`:

````markdown

## Execution

### 1. Resolve plan path

The user invokes `/run-plan <path>` or "跑這個 plan <path>". The path may be relative.

Resolve to absolute:
```bash
realpath "<user-provided path>"
```
Store as `$PLAN_PATH`. If the file does not exist, report `❌ plan not found: <path>` and STOP.

### 2. Read the plan

Use the Read tool on `$PLAN_PATH`. Count tasks:
- Total tasks = lines matching `^- \[ \]` or `^- \[x\]` (case-insensitive on `x`)
- Unchecked = lines matching `^- \[ \]`

If total tasks is 0, report `❌ no checkbox tasks found in <path>` and STOP.

If unchecked is 0, report `✅ all tasks already complete in <path>` and STOP.

### 3. Invoke codex in background

Generate a log path:
```
LOG="/tmp/run-plan-$(date +%Y%m%d-%H%M%S).log"
```

Run codex via Bash with `run_in_background: true`:

```bash
codex exec "<PROMPT — see Task 5>" \
  -C "$(dirname "$PLAN_PATH")" \
  -s workspace-write \
  -c 'model_reasoning_effort="high"' \
  > "$LOG" 2>&1
```

(Adjust flag names to match what `codex exec --help` showed in Task 1 Step 2.)

Bash returns a `shell_id`. Save it.

### 4. Wait for codex to finish

Use Monitor on the `shell_id` until the process exits. Do NOT send any message to the user during this wait.

### 5. Re-read the plan

Use Read on `$PLAN_PATH` again. Now compare:
- Tasks now checked (`- [x]`) — these are completed
- Tasks still unchecked (`- [ ]`) — these are NOT completed

### 6. Decide outcome

- If codex exit code == 0 AND unchecked == 0 → **All complete**
- If codex exit code == 0 AND unchecked > 0 → **Partial** (codex stopped voluntarily — usually means it hit an unresolvable error)
- If codex exit code != 0 → **Failure**

### 7. Report once and STOP

Use the report formats in the next section. Send exactly one message. Do not follow up.
````

- [ ] **Step 2: Verify**

Run:
```bash
grep -c "^### " ~/.claude/skills/run-plan/SKILL.md
```
Expected: `7` (the seven sub-steps).

---

## Task 5: Write codex prompt template and report formats

**Files:**
- Modify: `~/.claude/skills/run-plan/SKILL.md` (append)

- [ ] **Step 1: Append the codex prompt template section**

Append:

````markdown

## Codex prompt template

Use this exact prompt (substitute `<ABSOLUTE_PLAN_PATH>`):

```
Read the plan at <ABSOLUTE_PLAN_PATH>.

Execute every task currently marked `- [ ]`, in the order they appear in the
file. Skip any task already marked `- [x]` — it has been done in a previous run.

After completing each task:
  1. Update its `- [ ]` to `- [x]` in <ABSOLUTE_PLAN_PATH>
  2. Save the file immediately
  3. Move to the next unchecked task

Stop when either:
  - Every `- [ ]` has become `- [x]`, OR
  - You hit an error you cannot resolve. In that case: leave the failed task
    as `- [ ]`, write a one-line reason on stderr, and exit non-zero.

Do not ask for confirmation between tasks. Do not summarize at the end —
the supervisor reads the plan file directly to see what got done.
```
````

- [ ] **Step 2: Append the report formats section**

Append:

````markdown

## Report formats

The final message MUST use one of these three formats verbatim. No additional text before, after, or interleaved.

### All complete

```
✅ Task 1: <title>
✅ Task 2: <title>
...
All N tasks completed.
```

Where `<title>` is the text of the checkbox line, stripped of `- [x] ` prefix.

### Partial (codex stopped voluntarily, some tasks remain)

```
✅ Task 1: <title>
✅ Task 2: <title>
⬜ Task 3: <title>
⬜ Task 4: <title>

K/N completed. Run /run-plan again to resume.
```

K = count of `- [x]`, N = total tasks.

### Failure (codex exit code != 0)

```
❌ codex failed: <stderr last non-empty line, truncated to 100 chars>
log: <LOG path>
completed: Task A, Task B
```

If no tasks were completed, say `completed: (none)`.

## Resume

Because each completed task is persisted to the plan file as `- [x]`, resume
is automatic: re-running `/run-plan` on the same file picks up where it left
off. No separate state file needed. The codex prompt explicitly instructs it
to skip `- [x]` tasks.
````

- [ ] **Step 3: Verify the full SKILL.md is well-formed**

Run:
```bash
wc -l ~/.claude/skills/run-plan/SKILL.md
grep -c "^## " ~/.claude/skills/run-plan/SKILL.md
```
Expected: roughly 120–180 lines, and 4 top-level `##` sections (Execution, Codex prompt template, Report formats, Resume).

---

## Task 6: Create test fixtures

**Files:**
- Create: `~/.claude/skills/run-plan/fixtures/sample-plan.md`
- Create: `~/.claude/skills/run-plan/fixtures/expected-after.md`

- [ ] **Step 1: Write a tiny sample plan with 3 trivial tasks**

Create `~/.claude/skills/run-plan/fixtures/sample-plan.md`:

```markdown
# Sample Plan (test fixture)

- [ ] Create file `/tmp/run-plan-test/a.txt` with content `A`
- [ ] Create file `/tmp/run-plan-test/b.txt` with content `B`
- [ ] Create file `/tmp/run-plan-test/c.txt` with content `C`
```

- [ ] **Step 2: Write the expected post-run state**

Create `~/.claude/skills/run-plan/fixtures/expected-after.md`:

```markdown
# Sample Plan (test fixture)

- [x] Create file `/tmp/run-plan-test/a.txt` with content `A`
- [x] Create file `/tmp/run-plan-test/b.txt` with content `B`
- [x] Create file `/tmp/run-plan-test/c.txt` with content `C`
```

- [ ] **Step 3: Verify fixtures exist**

Run:
```bash
ls ~/.claude/skills/run-plan/fixtures/
```
Expected: shows both files.

---

## Task 7: Integration test — happy path

**Files:**
- Read only — no permanent modifications

- [ ] **Step 1: Prepare a fresh test workspace**

Run:
```bash
rm -rf /tmp/run-plan-test
mkdir -p /tmp/run-plan-test
cp ~/.claude/skills/run-plan/fixtures/sample-plan.md /tmp/run-plan-test/plan.md
cat /tmp/run-plan-test/plan.md
```
Expected: shows 3 unchecked tasks.

- [ ] **Step 2: Open a fresh Claude Code session and invoke the skill**

In a new Claude Code session (so the skill loads fresh), say:

```
/run-plan /tmp/run-plan-test/plan.md
```

- [ ] **Step 3: Observe Claude's behavior during execution**

Expected:
- Claude reads the plan file
- Claude starts a background Bash with `codex exec`
- Claude says NOTHING during the wait (this is the critical observation — if Claude says anything before codex finishes, the HARD-GATE failed and Task 3 needs revision)
- Eventually Claude prints exactly:
  ```
  ✅ Task 1: Create file `/tmp/run-plan-test/a.txt` with content `A`
  ✅ Task 2: Create file `/tmp/run-plan-test/b.txt` with content `B`
  ✅ Task 3: Create file `/tmp/run-plan-test/c.txt` with content `C`
  All 3 tasks completed.
  ```

- [ ] **Step 4: Verify the side effects**

Run:
```bash
cat /tmp/run-plan-test/a.txt /tmp/run-plan-test/b.txt /tmp/run-plan-test/c.txt
diff /tmp/run-plan-test/plan.md ~/.claude/skills/run-plan/fixtures/expected-after.md
```
Expected: prints `A`, `B`, `C` on three lines, and `diff` returns no output (files identical).

- [ ] **Step 5: If Claude said anything mid-run, tighten the HARD-GATE**

If Step 3 observed Claude saying anything before codex finished, edit `~/.claude/skills/run-plan/SKILL.md` and add the specific forbidden phrase to the HARD-GATE's explicit forbidden list. Re-run Step 1–4 until silent.

---

## Task 8: Integration test — resume after interruption

**Files:**
- Read only — no permanent modifications

- [ ] **Step 1: Prepare a partially-completed plan**

Run:
```bash
rm -rf /tmp/run-plan-test
mkdir -p /tmp/run-plan-test
cat > /tmp/run-plan-test/plan.md <<'EOF'
# Sample Plan (resume test)

- [x] Create file `/tmp/run-plan-test/a.txt` with content `A`
- [ ] Create file `/tmp/run-plan-test/b.txt` with content `B`
- [ ] Create file `/tmp/run-plan-test/c.txt` with content `C`
EOF
echo "A" > /tmp/run-plan-test/a.txt  # simulate the first task was already done
ls /tmp/run-plan-test/
```
Expected: `a.txt` exists, `b.txt` and `c.txt` do not.

- [ ] **Step 2: Invoke the skill again**

In a fresh Claude Code session:
```
/run-plan /tmp/run-plan-test/plan.md
```

- [ ] **Step 3: Verify codex skipped Task 1**

After Claude finishes, check:
```bash
ls /tmp/run-plan-test/
cat /tmp/run-plan-test/a.txt
```
Expected: `a.txt` still contains `A` (was not re-created — codex skipped it), and `b.txt` + `c.txt` now exist.

- [ ] **Step 4: Verify report shows all 3 as ✅**

Claude's report should be:
```
✅ Task 1: Create file `/tmp/run-plan-test/a.txt` with content `A`
✅ Task 2: Create file `/tmp/run-plan-test/b.txt` with content `B`
✅ Task 3: Create file `/tmp/run-plan-test/c.txt` with content `C`
All 3 tasks completed.
```

Note: Task 1 shows ✅ even though codex didn't do it this run — it's ✅ because the plan file already had `- [x]`. This is correct: the report reflects the final state of the plan, not what codex did this run.

---

## Task 9: Integration test — failure path

**Files:**
- Read only

- [ ] **Step 1: Prepare a plan with an impossible task**

```bash
rm -rf /tmp/run-plan-test
mkdir -p /tmp/run-plan-test
cat > /tmp/run-plan-test/plan.md <<'EOF'
# Sample Plan (failure test)

- [ ] Create file `/tmp/run-plan-test/a.txt` with content `A`
- [ ] Do something impossible: read /nonexistent/file/path/xyz.txt and print its contents
- [ ] Create file `/tmp/run-plan-test/c.txt` with content `C`
EOF
```

- [ ] **Step 2: Invoke the skill**

In a fresh Claude Code session:
```
/run-plan /tmp/run-plan-test/plan.md
```

- [ ] **Step 3: Verify partial / failure handling**

Expected outcome (one of two — both are acceptable):

**(a) Codex exits non-zero on the impossible task:**
```
❌ codex failed: <some error about /nonexistent/file/path/xyz.txt>
log: /tmp/run-plan-<ts>.log
completed: Task 1
```

**(b) Codex exits 0 but skips the impossible task (leaving it `- [ ]`):**
```
✅ Task 1: Create file `/tmp/run-plan-test/a.txt` with content `A`
⬜ Task 2: Do something impossible: read /nonexistent/file/path/xyz.txt and print its contents
✅ Task 3: Create file `/tmp/run-plan-test/c.txt` with content `C`

2/3 completed. Run /run-plan again to resume.
```

The important assertion: Claude reports correctly without trying to "help" or "fix" the failure. If Claude tries to debug, edit files, or suggest workarounds → the HARD-GATE failed. Add the observed misbehavior to the forbidden list and re-test.

---

## Task 10: Test the "no checkbox" edge case

**Files:**
- Read only

- [ ] **Step 1: Create a plan with no checkboxes**

```bash
rm -rf /tmp/run-plan-test
mkdir -p /tmp/run-plan-test
cat > /tmp/run-plan-test/plan.md <<'EOF'
# Just a description, no tasks

This is just prose. No checkboxes here.
EOF
```

- [ ] **Step 2: Invoke the skill**

In a fresh session:
```
/run-plan /tmp/run-plan-test/plan.md
```

- [ ] **Step 3: Verify the early-exit error**

Expected output (one line, nothing else):
```
❌ no checkbox tasks found in /tmp/run-plan-test/plan.md
```

Codex must NOT have been invoked. Verify no `/tmp/run-plan-*.log` was created for this run.

---

## Task 11: Test the "bad path" edge case

**Files:**
- Read only

- [ ] **Step 1: Invoke the skill with a nonexistent path**

```
/run-plan /tmp/does-not-exist.md
```

- [ ] **Step 2: Verify the error**

Expected:
```
❌ plan not found: /tmp/does-not-exist.md
```

No codex invocation, no log file.

---

## Task 12: Final commit

**Files:**
- Stage: spec + plan in the discord project
- The skill itself lives in `~/.claude/skills/run-plan/` and is not part of any repo

- [ ] **Step 1: Verify the project git status**

Run:
```bash
git -C /Users/m2107007/Desktop/code/claudecode-discord status
```
Expected: shows untracked or modified spec and plan files under `docs/superpowers/`.

- [ ] **Step 2: Stage and commit**

```bash
git -C /Users/m2107007/Desktop/code/claudecode-discord add \
  docs/superpowers/specs/2026-05-18-run-plan-skill-design.md \
  docs/superpowers/plans/2026-05-18-run-plan-skill.md
git -C /Users/m2107007/Desktop/code/claudecode-discord commit -m "docs: add /run-plan skill spec and implementation plan

Spec for a user-global skill that supervises codex exec running an entire
plan file. Reports a ✅/⬜/❌ checklist and nothing else. Designed to stop
Claude from interrupting mid-execution.

The skill itself is installed at ~/.claude/skills/run-plan/ (not in this repo).

Co-Authored-By: Claude <noreply@anthropic.com>"
```

- [ ] **Step 3: Verify commit**

```bash
git -C /Users/m2107007/Desktop/code/claudecode-discord log -1 --stat
```
Expected: shows the commit with both markdown files.

---

## Self-Review Notes

**Spec coverage check:**
- ✅ "薄包裝 / 唯一合法序列" → Tasks 3, 4 (HARD-GATE + Execution sections)
- ✅ "markdown checkbox 落地進度" → Task 5 (codex prompt), Task 8 (resume test)
- ✅ "純靜默同步等待" → Task 4 Step 5–6 (Monitor wait), Task 7 Step 3 (silence assertion)
- ✅ "✅/⬜/❌ 回報格式" → Task 5 Step 2 (report formats section)
- ✅ "Skill 位置 ~/.claude/skills/run-plan/" → Task 2
- ✅ "邊界條件" — no checkbox, bad path, codex fail → Tasks 9, 10, 11
- ✅ "Resume 不需要 state file" → Task 5 (codex prompt skip-x rule), Task 8 (resume test)
- ✅ "5 條成功標準 — 5 次測試裡 Claude 沒有任何一次中途冒出來" → Task 7 Step 3 assertion + Step 5 iterate-until-silent loop

**Placeholders:** none.

**Type/name consistency:** `$PLAN_PATH`, `$LOG`, fixture filenames, and the three report formats are consistent across Tasks 4, 5, 7, 8, 9.

**Coverage gap considered:** Codex CLI flag names are approximate (Step 1 Task 1 instructs to verify against `codex exec --help`). This is acceptable because flags vary by codex version — locking exact flag names would make the plan fragile.
