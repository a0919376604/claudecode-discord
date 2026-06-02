# `/devsync` Slash Command for claudecode-discord

**日期**: 2026-06-03
**作者**: brainstorm with Claude
**狀態**: approved, ready for implementation plan
**Implementation plan**: (to be created via `writing-plans` skill)

---

## Problem

`devsync` 是一個剛完成的 Python CLI（`~/Desktop/code/devsync`，v0.1.0），把
Mutagen 包成一指令 sync-and-SSH 工作流：

```bash
devsync doctor                  # 健檢 4 台 dl0x
devsync start <repo> <server>   # 開 sync + 自動 SSH
devsync ls / stop / status / flush / logs / ssh
```

當使用者在外面、用手機，想看「我的 sync session 還在嗎？」、「dl02 還活著嗎？」、
「幫我把那個 session 關了」—— 沒有方便的入口。打開 Discord 用 DM 跟 Claude 講
「跑 devsync ls」可以，但每次都要打一句話、等 Claude 啟動 session、解析意圖、
shell-out、回讀結果，**5-10 秒延遲、token 成本不小**。

理想是 Discord 直接打 `/devsync ls`，bot 0.5 秒內 echo 表格。

## Root cause

`claudecode-discord` bot 本來就跑在 devsync 同一台機器上，已經有 Discord
slash command 註冊機制（`src/bot/commands/*.ts` + `src/bot/client.ts` 的
`commands` array）。缺的只是一個對應 `devsync` CLI 的 command handler。

## Solution

在 `claudecode-discord` 內新增一個靜態 slash command `/devsync`，handler
直接 spawn 本機的 `devsync` binary、把 stdout 包成 Discord code block 回傳。
對於有衝突的 `start` 用 Discord button 處理 reuse/restart/cancel；對於有
破壞性的 `stop_all` 用 confirm button 防呆。

刻意**不**走 Claude session 路徑（不丟給 SDK、不開 Claude turn）。原因：

- devsync 是 deterministic CLI，沒有需要 LLM 推理的部分
- shell-out 比 Claude session 快 ~100x、不耗 token
- session conflict 處理用 Discord native button 就行，不需要對話

---

## Requirements

### Functional

- **REQ-001** — 在 `claudecode-discord` 內提供 `/devsync` slash command，含 7 個 subcommand：
  `doctor`, `ls`, `start`, `stop`, `stop_all`, `status`, `flush`。
- **REQ-002** — `/devsync` 在 bot 服務的任何 channel 都能跑，**不要求** project 註冊（與既有 `/status` 同模式）。
- **REQ-003** — 所有 subcommand 透過子程序執行本機的 `devsync` CLI（不重實作邏輯）。
- **REQ-004** — Output 統一用 Discord code block 包覆，保留 Rich 表格的 monospace 對齊。
- **REQ-005** — `/devsync start <repo> <server>` 偵測到 session 已存在時，回三個 button：Reuse / Restart / Cancel。預設不會自動 reuse 或 restart。
- **REQ-006** — `/devsync stop_all` 在有 active session 時，先回 confirm + cancel 兩個 button；按 confirm 才真的執行。
- **REQ-007** — `<server>` 參數提供 autocomplete，候選來自 `~/.config/devsync/config.toml` 的 `[servers.*]` keys。
- **REQ-008** — `<repo>` 參數（用於 `stop` / `status` / `flush`）提供 autocomplete，候選來自當前 `devsync ls` active sessions 的 repo 名稱（從 session name `<repo>--<server>` 拆出 `<repo>`，de-dup）。
- **REQ-009** — `runDevsync` wrapper（`src/utils/devsync-cli.ts`）是唯一直接呼叫 `child_process.spawn('devsync', ...)` 的位置。
- **REQ-010** — 錯誤訊息對特定情況加 hint：
  - exit code 127（找不到 binary）→ 加 install hint
  - stderr 含 `Cannot reach server` → 加 VPN hint
- **REQ-011** — 輸出超過 1900 字時截斷並附 `... (truncated)` 提示（Discord message 上限 2000）。

### Non-Functional

- **REQ-020** — `/devsync` 跟既有 14 個內建 slash command 一樣，透過 `client.ts` 的 `commands` array 註冊（無 Claude session）。
- **REQ-021** — `runDevsync` 預設 timeout 30 秒（涵蓋 doctor 最壞 ~20s）。
- **REQ-022** — Bot 不假設 devsync binary 路徑；走 `process.env.PATH`，預設能在 `~/.local/bin/` 找到（`uv tool install` 的標準位置）。
- **REQ-023** — 不引入新 npm dependency；用 Node.js 內建 `child_process` 跟既有 `discord.js`。
- **REQ-024** — i18n：v0.1 只裝英文 facade（用既有 `L("en", "ko")` 但同字串）。後續 polish 再補韓文。

---

## Constraints

- **CON-001** — `devsync` CLI 必須安裝在 bot 機器（`uv tool install ~/Desktop/code/devsync`），且 `~/.config/devsync/config.toml` 已配置。
- **CON-002** — Bot 跑在 macOS / Linux；不支援 Windows（與 claudecode-discord 整體一致：tray app 雖然跨平台，但實際 devsync 是 macOS-only）。
- **CON-003** — Multi-bot setup：每台機器有自己的 bot + 自己的 devsync 配置。`/devsync ls` 顯示**該 bot 機器**的 sessions，不跨機。設計上不嘗試「集中視圖」。
- **CON-004** — Discord button customId 上限 100 字。Session name 格式 `<repo>--<server>` 通常 < 40 字，留有空間給前綴 `devsync:start:restart:` （22 字）。
- **CON-005** — Discord slash command response 必須在 3 秒內 ack（用 `interaction.deferReply()`），實際內容透過 `editReply` 補（15 分鐘窗口）。
- **CON-006** — `/devsync` 命名跟 `devsync` CLI 名稱衝突的可能性：使用者也可能在 `~/.claude/commands/devsync.md` 放一個同名 plugin command。`PluginRegistry` 已經有 conflict 偵測，內建靜態命令優先（見 `botOwnedCommandNames` Set）。

---

## Architecture Overview

### High-Level Components

```
                ┌───────────────────────────────────────────────┐
                │  Discord (slash command + button click events) │
                └───────────────────┬───────────────────────────┘
                                    │
                                    ▼
        ┌──────────────────────────────────────────────────────┐
        │                claudecode-discord bot                 │
        │                                                       │
        │  src/bot/client.ts                                    │
        │    ├─ commands array  ──→  registerSlashCommands()   │
        │    └─ interactionCreate dispatcher                   │
        │           ├─ ChatInputCommand  ──→  commandMap       │
        │           └─ Button       ──→  prefix dispatch       │
        │                  ├─ perm:*  (existing)               │
        │                  └─ devsync:*  (NEW)                 │
        │                                                       │
        │  src/bot/commands/devsync.ts        (NEW)            │
        │    ├─ data: SlashCommandBuilder w/ 7 subcommands     │
        │    ├─ execute(interaction)  ──→  per-subcommand fns  │
        │    └─ autocomplete(interaction)                      │
        │                                                       │
        │  src/bot/handlers/devsync-buttons.ts  (NEW)          │
        │    ├─ devsync:start:reuse:<name>                     │
        │    ├─ devsync:start:restart:<name>                   │
        │    ├─ devsync:start:cancel                           │
        │    ├─ devsync:stop_all:confirm                       │
        │    └─ devsync:stop_all:cancel                        │
        │                                                       │
        │  src/utils/devsync-cli.ts             (NEW)          │
        │    └─ runDevsync(args, opts)  ──┐                    │
        └──────────────────────────────────┼───────────────────┘
                                           │ spawn('devsync', ...)
                                           ▼
                ┌──────────────────────────────────────────────┐
                │  devsync v0.1.0 CLI (~/.local/bin/devsync)   │
                │    → wraps mutagen daemon                    │
                └──────────────────────────────────────────────┘
```

### Single Source of Authority

`/devsync` 的執行狀態 = `devsync` CLI 的狀態 = `mutagen` daemon 的狀態。
Bot 不維護自己的 session state，每次 `/devsync ls` 都即時 spawn。
這跟 devsync 自己的「no local state」設計呼應。

---

## Detailed Design

### §5.1 Slash command interface

```
/devsync doctor
/devsync ls
/devsync start <repo:string> <server:string>      # server autocomplete
/devsync stop <repo:string>                        # repo autocomplete
/devsync stop_all
/devsync status <repo:string>                      # repo autocomplete
/devsync flush <repo:string>                       # repo autocomplete
```

### §5.2 File layout (new files)

```
src/
├── bot/
│   ├── commands/
│   │   └── devsync.ts              ← SlashCommandBuilder + 7 subcommand handlers + autocomplete
│   └── handlers/
│       └── devsync-buttons.ts      ← Button interaction handler
├── utils/
│   └── devsync-cli.ts              ← runDevsync(args, opts) wrapper

tests/  (vitest):
├── devsync.test.ts                 ← subcommand routing + format + autocomplete
├── devsync-buttons.test.ts         ← button flows
└── devsync-cli.test.ts             ← spawn wrapper unit tests
```

### §5.3 `runDevsync` type contract

```typescript
export interface DevsyncResult {
  ok: boolean;          // exit code === 0
  code: number;         // exit code (-1 on timeout, 127 on ENOENT)
  stdout: string;       // ANSI-stripped
  stderr: string;       // ANSI-stripped
}

export async function runDevsync(
  args: string[],
  opts?: { timeoutMs?: number; input?: string },
): Promise<DevsyncResult>;
```

- 預設 `timeoutMs = 30_000`
- ANSI: `s.replace(/\[[0-9;]*m/g, '')`
- ENOENT (devsync not on PATH) → `{ok: false, code: 127, stderr: "devsync CLI not found. Install: uv tool install ~/Desktop/code/devsync"}`

### §5.4 Button customId convention

```
devsync:start:reuse:<sessionName>       e.g., devsync:start:reuse:foo--dl02
devsync:start:restart:<sessionName>     e.g., devsync:start:restart:foo--dl02
devsync:start:cancel                    (no session needed)
devsync:stop_all:confirm
devsync:stop_all:cancel
```

`client.ts` 的 button dispatcher 多一條：`customId.startsWith('devsync:')` → `handleDevsyncButton(interaction)`。

### §5.5 Subcommand behavior

| Subcommand | Pre-check | Action | Output |
|---|---|---|---|
| `doctor` | (none) | `devsync doctor` | code block of stdout |
| `ls` | (none) | `devsync ls` | code block of stdout |
| `start` | `devsync ls` → check if `<repo>--<server>` exists | exists → 3 button reply; not exist → `devsync start ... --no-ssh` | code block on success |
| `stop` | (none) | `devsync stop <repo>` | one-liner success / error |
| `stop_all` | `devsync ls` → count | 0 → "no sessions"; N → confirm button → on confirm `devsync stop --all` | one-liner |
| `status` | (none) | `devsync status <repo>` | code block of stdout |
| `flush` | (none) | `devsync flush <repo>` | one-liner success |

### §5.6 Autocomplete sources

- `<server>` (used by `start`): parse `~/.config/devsync/config.toml`, return keys of `[servers.*]`.
- `<repo>` (used by `stop` / `status` / `flush`): run `devsync ls`, parse session names `<repo>--<server>`, extract distinct `<repo>` values.

Cache: autocomplete handlers run on every keystroke; spawning per-keystroke is acceptable for v0.1 (devsync ls is <100ms). v0.2 may cache.

### §5.7 Error handling

| Case | Behavior |
|---|---|
| `runDevsync` returns `ok: false` | `editReply` with `✗ devsync <sub> failed (exit N)\n\`\`\`\n<stderr-or-stdout>\n\`\`\`` |
| `code === 127` (ENOENT) | Append: "Install: \`uv tool install ~/Desktop/code/devsync\`" |
| stderr contains `Cannot reach server` | Append: "Check VPN: run \`/vpn status\` on the bot host" |
| Output > 1900 chars | Truncate, append `... (truncated)` |
| Race: `start` pre-check says no session, but `devsync start` returns `SessionAlreadyExists` | Catch stderr containing "already exists" → fall back to button flow |
| Unauthorized user | Existing `isAllowedUser()` guard in `client.ts` covers this |
| Unknown button customId starting with `devsync:` | Log warning, no action |

---

## Test Strategy

### Layer 1: `runDevsync` unit tests (mock spawn)

`tests/devsync-cli.test.ts`:
- success: stdout/stderr captured, `ok === true`, code === 0
- non-zero exit: `ok === false`, code mirrored
- ANSI in stdout → stripped
- timeout → process killed, `ok: false, code: -1`
- ENOENT → `code: 127`, install-hint stderr

### Layer 2: Subcommand handler tests (mock `runDevsync`)

`tests/devsync.test.ts`: covers
- `doctor` and `ls` wrap stdout in code block
- `start` pre-check no-conflict → spawns start
- `start` pre-check conflict → editReply with 3 buttons (assert customId format)
- `start` race condition (pre-check OK but spawn fails with "already exists") → falls back to buttons
- `stop` happy + autocomplete repo source
- `stop_all` 0 sessions → no buttons
- `stop_all` N sessions → confirm button
- `status` / `flush` happy
- error: `code === 127` → install hint in editReply
- error: stderr "Cannot reach server" → VPN hint
- error: output > 1900 → truncated + "(truncated)" marker
- autocomplete server source reads config.toml

### Layer 3: Button handler tests

`tests/devsync-buttons.test.ts`:
- `devsync:start:reuse:<name>` → editReply "Reusing", does **not** call runDevsync
- `devsync:start:restart:<name>` → calls runDevsync stop then start in order
- `devsync:start:cancel` → editReply "Cancelled"
- `devsync:stop_all:confirm` → calls runDevsync(['stop', '--all'])
- `devsync:stop_all:cancel` → editReply "Cancelled"
- Unknown customId prefix → early return (no error)

### Smoke checklist (manual, added to README)

```
[ ] /devsync doctor                          → 4-server table renders
[ ] /devsync ls                              → sessions list (or "No active sessions")
[ ] /devsync start foo dl02                  → session created; bot echoes success
[ ] /devsync start foo dl02 (repeat)         → 3 buttons appear (Reuse/Restart/Cancel)
[ ] press Cancel                             → message updates to "Cancelled."
[ ] /devsync start foo dl02 → Restart        → old session terminated, new one starts
[ ] /devsync stop foo                        → session terminated
[ ] /devsync stop_all (with N sessions)      → 2 buttons (Confirm/Cancel)
[ ] press Confirm                            → all sessions terminated
[ ] autocomplete on /devsync stop <repo>     → lists current repos
[ ] autocomplete on /devsync start <server>  → lists dl01-04
[ ] /devsync status <repo> output > 2000ch   → truncated correctly
[ ] devsync binary missing                   → install hint shown
```

### Not tested

- devsync CLI internal behavior (out of scope)
- Real Discord interaction objects (use existing mock pattern from `sessions.test.ts`)
- Coverage % (anti-pattern)

---

## Acceptance Criteria

### AC-001 — Read-only commands work end-to-end

- **Given** devsync CLI installed and config valid
- **When** user runs `/devsync doctor` in Discord
- **Then** bot replies within 3s (deferred), edits with code block containing 4-server table.

### AC-002 — `/devsync ls` reflects mutagen daemon state

- **Given** an active mutagen sync session
- **When** user runs `/devsync ls`
- **Then** bot replies with a code block whose inner text matches `devsync ls` CLI output 1:1 (after ANSI escape sequence removal).

### AC-003 — `/devsync start` creates new session when no conflict

- **Given** no existing session for `<repo>--<server>`
- **When** user runs `/devsync start foo dl02`
- **Then** bot calls `devsync start foo dl02 --no-ssh`, replies with success message, and `/devsync ls` afterward shows the new session.

### AC-004 — `/devsync start` shows 3 buttons on conflict

- **Given** an existing session for `<repo>--<server>`
- **When** user runs `/devsync start <same-repo> <same-server>`
- **Then** bot replies with 3 buttons (Reuse / Restart / Cancel) and the session is **not** modified yet.

### AC-005 — Restart button terminates and recreates

- **Given** the 3-button reply from AC-004
- **When** user clicks Restart
- **Then** old session is terminated, new session is created, message updates to confirm.

### AC-006 — `/devsync stop_all` requires confirmation

- **Given** N≥1 active devsync-managed sessions
- **When** user runs `/devsync stop_all`
- **Then** bot replies with Confirm/Cancel buttons including count "Terminate N session(s)"; sessions remain until Confirm.

### AC-007 — Autocomplete `<server>` lists configured servers

- **Given** `~/.config/devsync/config.toml` has dl01-dl04
- **When** user types `/devsync start foo ` (space, autocomplete trigger)
- **Then** Discord shows dl01, dl02, dl03, dl04 as choices.

### AC-008 — Autocomplete `<repo>` lists active session repos

- **Given** 2 active sessions: `alpha--dl01`, `beta--dl02`
- **When** user types `/devsync stop ` (autocomplete trigger)
- **Then** Discord shows `alpha` and `beta` (distinct).

### AC-009 — VPN-down error includes hint

- **Given** VPN is disconnected and some server is unreachable
- **When** user runs `/devsync doctor`
- **Then** bot still echoes the output (servers marked unreachable) and the message body includes "Check VPN".

### AC-010 — Install-missing error gives recovery hint

- **Given** `devsync` binary is not on PATH
- **When** user runs any `/devsync` subcommand
- **Then** bot replies with "✗ devsync CLI not found. Install: uv tool install ..." (no Python traceback or shell error).

---

## Implementation Roadmap (high level)

The `writing-plans` skill will produce concrete steps. Milestones:

| # | Milestone | Verification |
|---|---|---|
| M1 | `runDevsync` wrapper + unit tests | Layer-1 tests pass |
| M2 | Read-only subcommands (`doctor`, `ls`, `status`) | AC-001, AC-002 |
| M3 | Mutating subcommands without conflict (`stop`, `flush`, `stop_all` + confirm button) | AC-006 |
| M4 | `/devsync start` + reuse/restart/cancel button flow | AC-003, AC-004, AC-005 |
| M5 | Autocomplete + UX polish + smoke checklist | AC-007, AC-008, AC-009, AC-010 |

---

## Out of Scope (v0.1)

- ❌ Multi-machine aggregation (each bot shows its own machine's sessions only)
- ❌ devsync config editing (`/devsync config-set ...`) — user edits TOML directly
- ❌ `/devsync logs <repo>` (Mutagen monitor is tail-follow, not Discord-friendly)
- ❌ `/devsync ssh <repo>` (TTY interactivity, not slash-command-friendly)
- ❌ Embed-based rendering (v0.1 uses code blocks; embeds are a polish item)
- ❌ Korean i18n strings (use `L("en", "en")` placeholder; backfill later)
- ❌ Caching autocomplete output (spawn-per-keystroke is acceptable < 100ms)

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Bot user differs from devsync-installing user → `spawn` finds nothing on PATH | Friendly ENOENT error with install hint (AC-010) |
| `devsync ls` hangs if mutagen daemon is broken | 30s timeout in `runDevsync`; `/devsync doctor` surfaces daemon state |
| Discord 2000-char limit overflows on long `status` output | Truncate + `(truncated)` marker (REQ-011) |
| Multiple users press same button simultaneously | Discord automatically disables button on first interaction; second click is ignored |
| `devsync` CLI changes JSON/text format in a future version | Bot parses very loosely (substring matches, code-block passthrough). Plan to bump bot version when devsync breaks compat. |
| Bot machine ≠ devsync target machine (rare misconfig) | Out of scope — multi-bot pattern documented in README assumes 1:1 |

---

## Open Questions

None at brainstorm completion. All UX and structural decisions closed during §1–§5.
