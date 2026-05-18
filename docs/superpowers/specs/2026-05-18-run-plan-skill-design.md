# `/run-plan` Skill 設計文件

**日期**：2026-05-18
**作者**：brainstorm with Claude
**狀態**：approved, ready for implementation plan

---

## 1. 問題定義

使用者跑 `superpowers:brainstorming` → `superpowers:writing-plans` 後產出
`xxplan.md`（內含 markdown checkbox 形式的 task list）。使用者想把這個 plan
交給 `codex exec` 跑完，但目前在 Claude Code 裡用自然語言指示時，Claude 會：

- 每完成一個 task 就跑來問「要繼續嗎？」「這樣對嗎？」
- 在 task 之間插入大段分析、評論、改進建議
- 自己跳出來「幫忙」做 task，而不是交給 codex

使用者要的是一個薄監督層：丟出去、跑完、回報清單、結束。
**最終回報只要 `✅ Task N: title` 形式，不要任何其他文字。**

## 2. 解決方案總覽

新增 `~/.claude/skills/run-plan/SKILL.md`，一個 user-global skill。
觸發詞：`/run-plan <plan path>`、「跑這個 plan」、「執行 plan」。

### 核心執行流程（Claude 唯一合法的動作序列）

```
Read(plan.md)
  → Bash(codex exec ..., run_in_background, timeout 大)
  → 等 codex 結束
  → Read(plan.md)
  → 列出 ✅/⬜/❌ 清單回報
  → 結束
```

不在這個序列上的任何動作都是違規。

## 3. 設計決策

| 決策 | 選擇 | 理由 |
|---|---|---|
| 執行粒度 | 整個 plan 一次丟給 codex | 使用者選擇；Claude 變成最薄監督層 |
| 進度追蹤 | codex 修改 plan.md 的 markdown checkbox | 狀態落地 → 免費 resume；不靠 stdout 解析（codex 版本變動就壞） |
| 等待策略 | 純靜默同步等待 | 符合使用者「跑完才回報」需求；不打擾 |
| 回報格式 | `✅ Task N: title` / `⬜` / `❌` 三種符號，無解釋文字 | 使用者明確要求 |
| Skill 位置 | `~/.claude/skills/run-plan/SKILL.md` | user-global，跨專案 |
| 失敗 log 路徑 | `/tmp/run-plan-<timestamp>.log` | 失敗時可追蹤完整輸出 |

## 4. SKILL.md 內容骨架

```markdown
---
name: run-plan
description: Execute a markdown plan file by delegating all tasks to `codex exec`,
  then report which tasks completed. Use when asked to "run this plan", "execute
  plan", "跑這個 plan", or given a path to an xxplan.md.
---

# Run Plan

Supervise codex executing an entire plan file. Report completion list at the end. Nothing else.

<HARD-GATE>
The ONLY legal tool sequence in this skill is:

  1. Read(plan.md)
  2. Bash(codex exec ...)        ← run_in_background: true, long timeout
  3. (wait for codex to finish via Monitor)
  4. Read(plan.md)               ← see which checkboxes got ticked
  5. Final report message
  6. END

Any tool call or message outside this sequence is a violation, including:
- Saying "let me confirm..." / "should I continue?" / "I noticed..."
- Using Edit/Write to modify any file yourself
- Using Grep/Glob to "understand context"
- Sending ANY text message to the user before codex finishes
- Explaining what codex is doing, commenting on the plan, suggesting improvements

If codex exec fails, your only allowed response is:
  ❌ codex failed: <stderr one-line summary>
  log: <log path>
  completed: Task A, Task B (those with [x] in plan.md)

Do NOT: try to do tasks yourself, debug the failure, propose fallbacks.
</HARD-GATE>

## Execution

1. **Read the plan file.** Identify all `- [ ]` checkbox tasks. Note their titles.

2. **Invoke codex** with a prompt that:
   - References the plan file by absolute path (resolve user-provided relative
     paths with `realpath` before passing in)
   - Tells codex to execute every unchecked task in order
   - Tells codex to update each `- [ ]` to `- [x]` immediately after completing that task
   - Tells codex to stop only when all tasks are done OR an unrecoverable error occurs

   Use the raw `codex exec` CLI directly (NOT the gstack `/codex` skill — that
   wrapper is for review/consult mode, not task execution).

   Because plans can take 10+ minutes, always invoke codex in background:
   ```
   Bash(command: "codex exec --skip-confirm '<prompt>' > /tmp/run-plan-<ts>.log 2>&1",
        run_in_background: true)
   → Monitor(shell_id) until process exits
   ```
   This is the only way to support arbitrarily long plans without hitting
   Bash's 10-minute timeout, and it keeps Claude silent during the wait.

3. **Read the plan file again** after codex exits. Count `- [x]` vs `- [ ]`.

4. **Report.** Use the exact format below. Send ONE message, then stop.

## Report format

All tasks complete:
```
✅ Task 1: <title>
✅ Task 2: <title>
...
All N tasks completed.
```

Partial completion (interrupted, or resumable):
```
✅ Task 1: <title>
✅ Task 2: <title>
⬜ Task 3: <title>
⬜ Task 4: <title>

2/4 completed. Run /run-plan again to resume.
```

Failure:
```
❌ codex failed at Task 3: <error one-liner>
log: /tmp/run-plan-<ts>.log
completed: Task 1, Task 2
```

## Resume behavior

If invoked on a plan with existing `- [x]` entries, the codex prompt MUST
include: "Only execute tasks marked `- [ ]`. Skip `- [x]` tasks."
This makes resume free — no separate state file.

## Codex prompt template

```
Read the plan at <ABSOLUTE_PLAN_PATH>.

Execute every task that is currently marked `- [ ]`, in the order they appear.
Skip any task marked `- [x]` (already done).

After completing each task:
  - Update the corresponding `- [ ]` in the plan file to `- [x]`
  - Save the file
  - Move to the next unchecked task

Stop only when:
  - All `- [ ]` tasks are now `- [x]`, OR
  - You hit an error you cannot resolve (then report which task failed and why)

Do not ask for confirmation between tasks. Do not summarize at the end —
the supervisor will read the plan file to see what got done.
```
```

## 5. 邊界條件

- **Plan 沒有 checkbox**：Read plan 後若找不到 `- [ ]`，直接報「no checkbox tasks found」並結束
- **Plan 路徑無效**：Read 失敗時立刻報錯，不呼叫 codex
- **codex 不存在**：Bash 失敗，報 `codex CLI not installed`
- **codex timeout**：因為用 background + Monitor，沒有硬性 timeout。若使用者中斷或 codex 自己 exit，Read plan 看部分完成狀態，當作「partial completion」回報
- **相對路徑**：`/run-plan ./plan.md` 要先 `realpath` 解析成絕對路徑再傳給 codex
- **使用者中途 Ctrl-C**：codex 已修改的 checkbox 留著，下次 `/run-plan` 自動 resume

## 6. 不在範圍內

- 自動 git commit（codex 自己處理 or 由 plan 內 task 指定）
- 把 plan 拆給多個 codex 平行跑
- 在跑的過程中即時 streaming 進度到使用者
- 自動產生 plan（那是 `superpowers:writing-plans` 的工作）
- 跑非 codex 的 executor（claude subagent、direct shell 等）

## 7. 成功標準

1. 使用者執行 `/run-plan path/to/xxplan.md`
2. Claude 從此一句話都不說，直到 codex 結束
3. Claude 回報一份 `✅ / ⬜ / ❌` 清單，無其他文字
4. 若中斷，再跑一次 `/run-plan` 從上次斷點繼續
5. 在 5 次連續測試中，Claude 沒有任何一次「中途冒出來問問題」
