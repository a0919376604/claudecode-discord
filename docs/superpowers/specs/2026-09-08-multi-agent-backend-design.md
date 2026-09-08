# Multi-Agent Backend (Claude / Codex) for claudecode-discord

**日期**:2026-09-08
**作者**:brainstorm with Claude
**狀態**:approved, ready for implementation plan

---

## Problem

目前 `claudecode-discord` 只能透過 `@anthropic-ai/claude-agent-sdk` 的
`query()` 跑 Claude Code。使用者無法在同一個 Discord bot 裡切換到
OpenAI 的 Codex CLI 當後端 —— 想用 codex 就得另外架另一個 bot 實例、
另外 register 頻道、另外管 auth。

需求:讓每個已註冊的 Discord 頻道能獨立選擇要用 Claude 還是 Codex,
UX 完全對齊(工具承認按鈕、串流輸出、Stop 按鈕、session resume、
進度顯示都要一致),但**底層 CLI/SDK 可以互換**。

## Root cause / motivation

現有 `src/claude/session-manager.ts`(970 行)深度綁定 Claude Agent SDK
的 `query()` API:

- `canUseTool` 回呼是 Claude 專屬的工具承認 hook
- `interrupt()`、`resume: sessionId`、`plugins`、`hooks`、`permissionMode`
  這些選項都是 Claude 語意
- 事件消費用 SDK 的 `SDKMessage` 型別(`system`/`assistant`/`result`)

Codex CLI 是完全不同模型:JSON-RPC over stdio(codex app-server 模式)、
自己的沙箱設定、`~/.codex/sessions/` session 儲存、`execCommandApproval`
反向呼叫承認機制。**兩邊的抽象層次是等價的**,但 API 表面完全不同。

這不是誰的錯 —— 是缺一層 backend-agnostic 的抽象。

## Goals

1. **Per-channel backend 選擇**。每個頻道獨立設定 backend,預設是 Claude。
2. **完全對齊的 Discord UX**。無論 backend 是誰,使用者看到的都是:
   - 串流的 assistant 文字(1.5s throttled edit)
   - 進度 heartbeat(每 15s)
   - 工具承認按鈕(approve/deny/approve-all)
   - Stop 按鈕
   - Session resume 跨 bot 重啟
3. **未來可擴充**。加第三個 backend(Gemini、Grok 等)的成本應該是
   「寫一個事件翻譯器 + 一個 slash command」,不是重構整個 bot。
4. **既有 Claude 使用者零回歸**。切換抽象層後,行為要跟現在完全一樣。

## Non-goals

- **不做 session 跨 backend 遷移**。Claude 對話無法帶到 codex 繼續(格式
  完全不同、模型行為不同)。切換 backend 時強制確認 + 清 session_id。
- **不做 per-message backend 選擇**。粒度是頻道級。想在同頻道跑不同
  backend 就分兩個頻道。
- **不做 auth 自動化**。codex 未登入時在 Discord 顯示教學文,不代跑
  `codex login`(auth 本質上是安全操作,無法安全自動化)。
- **不做 model 選擇 UI**。Claude 依然吃 `CLAUDE_MODEL` env var,codex
  吃自己的 `~/.codex/config.toml`。未來需求再加。

## Design

### 分層

新增 `src/agent/` 目錄放 backend 抽象層。既有 `src/claude/` 保留(避免
破壞現有測試),但 `session-manager.ts` 改造成 backend-agnostic 的 runner。

```
src/
├── agent/                         ← 新增
│   ├── backend.ts                 ← AgentBackend interface + NormalizedEvent union
│   ├── claude-backend.ts          ← 包 @anthropic-ai/claude-agent-sdk 的 query()
│   ├── codex-backend.ts           ← spawn `codex app-server` + JSON-RPC client
│   ├── codex-rpc.ts               ← JSON-RPC 2.0 over stdio(純 protocol、可 unit test)
│   ├── codex-detect.ts            ← 偵測 codex CLI 存在性 & 登入狀態
│   └── backend-factory.ts         ← getBackend(channelId) → AgentBackend
│
├── claude/
│   ├── session-manager.ts         ← 改造:內部用 backend-factory,不再 import query()
│   ├── output-formatter.ts        ← 不動
│   ├── progress-decision.ts       ← 不動
│   └── credentials-refresher.ts   ← Claude 專屬,從 SessionManager 移到 ClaudeBackend
│
├── bot/commands/
│   ├── claude.ts                  ← 新增 /claude(切到 Claude backend)
│   ├── codex.ts                   ← 新增 /codex(切到 codex backend + 確認 + 清 session)
│   ├── switch-backend.ts          ← 兩個 command 共用的 factory
│   ├── register.ts                ← 加 optional --backend flag
│   └── ...
│
└── db/
    └── database.ts                ← migration: ALTER TABLE projects ADD COLUMN backend TEXT NOT NULL DEFAULT 'claude'
```

**分層原則**:

- `src/agent/` **不能** import discord.js —— 純邏輯層,input 是 prompt/callbacks,
  output 是 async iterator
- `session-manager.ts` **不能** import 任何 SDK —— 只認 `AgentBackend` interface
- Backend 內部各自負責:
  - Claude → 沿用現有 `ensureFreshCredentials`、plugins、hooks、`CLAUDE_MODEL`
  - Codex → 自行處理 sandbox mode、model 選擇、`~/.codex/sessions/` 路徑

**命名選擇**:`src/agent/` 而非 `src/backends/` —— 未來還可能加「同一份
event stream 送給多個 sink」(e.g. 除了 Discord 也記到檔案),用 `agent`
更中性。

### NormalizedEvent Schema

```ts
// src/agent/backend.ts

export type NormalizedEvent =
  // ─── 純資訊事件(SessionManager 收下就好,不必回應)──────────────

  // Session 開始,backend 拿到 session_id 後立刻 emit。
  // SessionManager 用來寫 DB 的 sessions.session_id 供未來 resume。
  | { type: "session_init"; sessionId: string }

  // 串流的 assistant 文字。isReasoning=true 給 codex 的 o3/gpt-5
  // 思考過程用(SessionManager 之後可選擇 italicize、或直接 fold 進正文)。
  | { type: "text_delta"; text: string; isReasoning?: boolean }

  // 工具開始執行(所有工具都 fire,包括讀取類)。
  // SessionManager 用來更新 lastActivity、toolUseCount、surfaceProgress()。
  | { type: "tool_start"; toolName: string; input: Record<string, unknown> }

  // 工具完成(可選 —— 有些 backend 不見得 emit,SessionManager 缺席也 OK)。
  | { type: "tool_end"; toolName: string; ok: boolean }

  // Turn 結束。costUsd 可選(codex 未必有);durationMs 由 SessionManager
  // 自己從 send time 算,backend 不必提供。
  | { type: "result"; text: string; costUsd?: number; isError: boolean }

  // ─── 需要回應的事件(SessionManager 顯示 UI → 呼叫 respondXxx)──────

  // 需要使用者承認的工具。Read-only 工具(Read/Glob/Grep 等)
  // 由 backend 內部自動承認,不 emit 這個事件。
  | { type: "tool_approval_request"; requestId: string; toolName: string; input: Record<string, unknown> }

  // AskUserQuestion —— 目前只有 Claude 原生支援。
  // codex 沒對等機制,backend 內部拒絕並顯示 warning(見 Fallback 節)。
  | { type: "ask_question_request"; requestId: string; questions: AskQuestionData[] };
```

**AgentBackend interface**:

```ts
export interface BackendStartOptions {
  prompt: string;
  cwd: string;
  resumeSessionId?: string;       // 上次的 session_id,undefined 就開新 session
  skipPermissions: boolean;        // Claude: bypassPermissions; codex: sandbox=danger-full-access
  channelId: string;               // wakeup env passthrough
  model?: string;                  // Claude: model; codex: --model
}

export interface AgentBackend {
  start(opts: BackendStartOptions): AsyncIterableIterator<NormalizedEvent>;
  interrupt(): Promise<void>;

  // SessionManager 收到 *_request 後、顯示 UI、拿到答案,呼叫這些方法。
  // 這些方法必須是 fire-and-forget(backend 內部 resolve pending promise)。
  respondToApproval(requestId: string, decision: "allow" | "deny", message?: string): void;
  respondToQuestion(requestId: string, answersByQuestionText: Record<string, string>): void;

  // 判斷 resume 失敗是不是「session id 已 stale」—— 用來決定要不要
  // silently retry without resume(現有 Claude 邏輯的廣義化)。
  isResumeStaleError(error: unknown): boolean;

  // 從 error / result 訊息判斷是否為 auth 失敗,回傳給 Discord 顯示的教學文
  // (Claude:"claude login";Codex:"codex login")。
  getAuthErrorHint(error: unknown): string | null;
}
```

### 關鍵設計決策的理由

1. **為什麼 approval 是 event 而不是 callback**
   讓事件流是單一入口,SessionManager 的 `for await` 迴圈可以線性處理
   所有東西,不必再有第二條「callback 從側面戳進來」的路徑。
   Backend 內部負責把 SDK 的承認 Promise 卡在
   `pendingApprovals.get(requestId).promise` 上;SessionManager 呼叫
   `respondToApproval` 時 resolve 這個 promise,SDK 就繼續往下跑。

2. **為什麼 `tool_start` 跟 `tool_approval_request` 分兩個事件**
   讀取工具(Read/Glob/Grep)需要更新進度但不需要承認 —— 只 emit
   `tool_start`。寫入工具兩個都 emit(先 start 顯示進度,再 approval
   要求決策)。分開比 `tool_start { needsApproval: true }` 這種 flag 乾淨。

3. **`interrupt()` 的責任**
   必須 resolve 所有還在 pending 的 approval/question promise(用 "deny"),
   否則 SDK 內部會永遠卡住,`for await` 也永遠不會結束。

4. **timeout 邏輯放哪**
   從現有的 `canUseTool` 內部移到 SessionManager —— 因為 5 分鐘 timeout
   是 Discord UX 決策,不是 backend 決策。Timeout 到就呼叫
   `backend.respondToApproval(id, "deny", "timed out")`。

5. **`durationMs` 為什麼不放 result 事件裡**
   SessionManager 從 `startTime = Date.now()` 已經在算,重複反而容易
   對不上(backend 的計時可能少了 SDK boot / Discord edit 的時間)。

### ClaudeBackend 實作要點

大部分是搬既有 code。`ensureFreshCredentials` 從 SessionManager 移進來
第一行呼叫。`query()` options 完全照舊(cwd、plugins、hooks、model、resume、
env、canUseTool)。

**難點**:`canUseTool` 是 sync-await callback,但 `AsyncIterator` 想
yield 事件。解法:內部維護 `eventQueue`,`canUseTool` 把事件 push 進
queue 並卡在 pending promise 上;主迴圈每次收到 SDK message 後
`yield* drainEventQueue()`,把 queue 裡累積的事件 flush 出去,然後才
yield SDK message 翻譯出的事件。

**SDK message → NormalizedEvent 翻譯**:

| SDK message | NormalizedEvent |
|---|---|
| `system` + `subtype:"init"` | `session_init { sessionId }` |
| `assistant` + text block | `text_delta { text }` |
| (內部)`canUseTool` for read-only tool | `tool_start` only,直接自動承認 |
| (內部)`canUseTool` for gated tool | `tool_start` + `tool_approval_request` |
| (內部)`canUseTool` for `AskUserQuestion` | `ask_question_request` |
| `result` + `subtype:"success"` | `result { text, costUsd, isError:false }` |
| `result` + `subtype:"error_*"` 或 `is_error:true` | `result { text, isError:true }` |

### CodexBackend 實作要點

**開新 session 流程**:

1. 偵測 codex 存在 & 登入(見 `codex-detect.ts`)
2. `spawn("codex", ["app-server"])` 子行程
3. Initialize handshake:
   - client → server: `{"method":"initialize", "params":{"clientInfo":..., "capabilities":{...}}}`
   - client → server: `{"method":"initialized", "params":{}}`(notification)
4. 註冊反向 request handler:
   - `execCommandApproval` → emit `tool_approval_request { toolName:"Bash", input:{command} }`
   - `applyPatchApproval` → emit `tool_approval_request { toolName:"Write", input:{changes} }`
5. `thread/start` 或 `thread/resume`
6. yield `session_init { sessionId: threadId }`
7. `turn/start` with prompt,收 `turnId`
8. 主迴圈消耗 JSON-RPC notifications:

| Notification | NormalizedEvent |
|---|---|
| `item/started` (tool item) | `tool_start` |
| `item/agentMessage/delta` | `text_delta { text }` |
| `item/reasoning/textDelta` | `text_delta { text, isReasoning:true }` |
| `turn/completed` (success) | `result { text, isError:false }`,結束 |
| `turn/completed` (error) | `result { text, isError:true }`,結束 |

**JSON-RPC 幀格式**(LSP 風格):
```
Content-Length: 123\r\n\r\n{"jsonrpc":"2.0","id":1,"method":"initialize",...}
```

**`interrupt()`**:呼叫 `turn/interrupt { threadId, turnId }`,3 秒 timeout,
關掉子行程,resolve 所有 pending approval 為 deny。

**風險**:無官方 Node SDK,`codex-rpc.ts` 全自製。如果 OpenAI 之後推出
官方 SDK,`codex-rpc.ts` 可以直接換掉(interface 不變)。參考現有的
`codex-companion.mjs`(Claude Code plugin 內含的 codex bridge)作為
protocol 實作範本。

### SessionManager 改造

**不動的部分(~750 行)**:

- `flushStreamBuffer()`、`splitMessage()` 相關 helper
- `pendingApprovals` / `pendingQuestions` / `pendingCustomInputs` Map
- `messageQueue` / `pendingQueuePrompts`(在途訊息排隊)
- Public method:`stopSession`、`isActive`、`resolveApproval`、`resolveQuestion`、
  `resolveCustomInput`、`hasPendingCustomInput`、queue 相關 methods、`wakeUp`
- Heartbeat interval、`surfaceProgress()`、durationTimer
- responseBuffer、lastEditTime、bufferFinalized、progressMessage 這些 streaming state
- 主迴圈的 `try/finally` 骨架(activeSession 註冊、finally 清理、queue drain、
  wakeup drain)
- Resume-retry 邏輯(但廣義化為呼叫 `backend.isResumeStaleError()`)

**換掉的部分**:

`runQuery(useResume)` 改成 `runBackend(useResume)`:

```ts
const backend = getBackend(channelId);   // 從 backend-factory 拿

const runBackend = (useResume: boolean) => backend.start({
  prompt,
  cwd: project.project_path,
  resumeSessionId: useResume ? resumeSessionId : undefined,
  skipPermissions: skipPerms,
  channelId,
  model: getConfig().CLAUDE_MODEL,   // ClaudeBackend 吃;CodexBackend 忽略
});
```

`for await (const message of queryInstance)` 改成
`for await (const event of eventStream)`,switch 事件 type 對應處理。
每個 case 內部呼叫的既有 helper(`createToolApprovalEmbed`、
`updateSessionStatus`、`createAskUserQuestionEmbed`、`createResultEmbed`)
完全不動。

**現有 `pendingApprovals` map 語意保留**:它的 `resolve` callback 內部
改成呼叫 `backend.respondToApproval()`,而不是直接 resolve SDK 的
canUseTool promise。這樣 `interaction.ts` 裡處理按鈕點擊的程式碼
**一行都不用改**。

### DB Migration

沿用既有 pattern(PRAGMA table_info + ALTER TABLE):

```ts
if (!cols.some((c) => c.name === "backend")) {
  db.exec("ALTER TABLE projects ADD COLUMN backend TEXT NOT NULL DEFAULT 'claude'");
}
```

Type 更新:

```ts
export interface Project {
  channel_id: string;
  project_path: string;
  guild_id: string;
  auto_approve: number;
  source_path: string | null;
  backend: "claude" | "codex";   // 新增
  created_at: string;
}
```

新查詢:

```ts
export function setBackend(channelId: string, backend: "claude" | "codex"): void {
  db.prepare("UPDATE projects SET backend = ? WHERE channel_id = ?").run(backend, channelId);
}
```

**DEFAULT 'claude' 而非 nullable**:舊資料 migrate 後值明確為 'claude',
factory 不用處理 null,SQL 更簡單。

### Slash Commands:`/claude` 和 `/codex`

兩個命令共用 `createSwitchBackendCommand(target, displayName)` factory。

**行為矩陣**:

| 狀態 | 動作 |
|---|---|
| 頻道未 register | 回 ephemeral:「先用 `/register`」 |
| 已在目標 backend | 回 ephemeral:「✅ Already using X」 |
| Session 活躍中 | 回 ephemeral:「先 `/stop`」(不隱式中斷) |
| 需要確認 | 顯示 ephemeral 確認按鈕:「切到 Y 會清 X session 的續接關係,舊 session file 還在但這頻道不再 resume 它」 |
| 確認 yes | `clearSessionId(channelId)` + `setBackend(channelId, target)`;若 target 是 codex 順便跑 `detectCodex()`;顯示成功訊息 |
| 確認 no | 訊息改為「Cancelled」 |

**為什麼「有活躍 session 直接擋」而非「順便 stop」**:明示行為 vs 隱式
副作用。使用者自己 `/stop` 一次成本很低,換來「切 backend 不會不小心
中斷正在跑的東西」的可預測性。

**為什麼確認訊息用 ephemeral**:切 backend 是私人操作,不需要污染
channel history。

按鈕處理進 `interaction.ts` 現有的 button router,customId 模式
`switch-<target>-<channelId>-<yes|no>`。

### Codex 偵測 & Discord-side Onboarding

`src/agent/codex-detect.ts`:

```ts
export interface CodexDetection {
  ok: boolean;
  errorMessage: string;   // 已格式化好的 Discord markdown,含安裝連結
}

export async function detectCodex(): Promise<CodexDetection>
```

**三階段檢查**:

1. `which codex` — 執行檔存在
2. `codex --version` — 可執行
3. `codex auth status`(5s timeout)— 已登入

任一失敗回傳對應的 Discord markdown 錯誤訊息,包含:
- 安裝指令(`npm install -g @openai/codex` 或 `brew install codex`)
- 登入指令(`codex login` 或 `OPENAI_API_KEY` env)
- 官方文件連結

**呼叫時機(結果快取,per bot process)**:

1. `/codex` 確認按鈕點下去後
2. `sendMessage` 時如果 `project.backend === "codex"` 而且**沒**快取過
3. Backend spawn 失敗(`spawn ENOENT`)時 fallback 呼叫

**為什麼不在 bot 啟動時就 detect**:codex 是可選 backend,多數使用者
可能不裝 —— bot 啟動就跑 detect 沒意義且慢。

**CLAUDE.md「禁止手動指引」原則的折衷**:

`/codex` 的錯誤訊息確實叫使用者去 terminal 執行 `codex login`,部分違反
「수동 조치 금지」原則。折衷理由:

1. codex 只是**可選的次要 backend**,預設路徑(Claude)完全不受影響
2. 使用 `/codex` 是使用者主動 opt-in 的技術性操作
3. 錯誤訊息清楚給出安裝/登入指令 + 官方連結,不留白
4. install.sh / install.bat 未來可加自動裝 codex 的選項

## Testing strategy

**強單元測試**:

1. **`codex-rpc.ts` — JSON-RPC 幀 codec**
   - `Content-Length: N\r\n\r\n{json}` serialize / deserialize
   - Request/response id 配對
   - Server → client request dispatch 到正確 handler
   - Chunk 邊界踩到 header 中間、body 中間都能正確 buffer
   - 用 mock `Duplex` stream,不 spawn 真的 codex
   - **這是最有價值的測試** —— 通訊協定 bug 除錯超痛苦

2. **事件翻譯器(每個 backend 各一組)**
   - `claude-backend.ts` 的 SDK message → NormalizedEvent
   - `codex-backend.ts` 的 JSON-RPC notification → NormalizedEvent
   - 保護「未來 SDK 版本升級不會靜默改變事件形狀」

3. **`codex-detect.ts`**
   - Mock `exec()`,模擬三種狀況(找不到 / 沒登入 / 全綠),
     assert errorMessage 正確

4. **`switch-backend.ts` factory**
   - Mock `getProject` / `sessionManager.isActive`,assert 每個
     行為矩陣分支的 Discord API 呼叫正確

**整合測試**:

5. **CodexBackend end-to-end**:用超短 prompt spawn 真的 codex 驗證
   handshake → thread/start → 一輪 turn → result 完整跑通。
   `test.skipIf(!process.env.CI_HAS_CODEX)` 保護。

6. **`session-manager.ts` 用 mock backend 跑一次**:塞
   `MockAgentBackend` 進去,emit 一連串固定事件(session_init →
   tool_start → tool_approval_request → 使用者 approve → text_delta →
   result),assert Discord API 呼叫序列正確、DB state 正確。
   **這個 test 是「refactor 後行為保留」的最強證據**。

**明確不測**:

- Discord.js 本身的行為(framework 邊界外)
- Claude SDK / Codex CLI 內部(供應商責任)

## Fallback:codex 沒對等物的情境

### AskUserQuestion

Codex app-server 只有 `execCommandApproval` / `applyPatchApproval`,
沒有結構化提問。

**處理**:實務上 codex 世界裡 skill 少、`AskUserQuestion` 幾乎不會
被 codex 呼叫(它是 Claude Agent SDK 的 tool,不是 codex 內建工具)。
如果真的觸發:

- Discord 顯示 warning:「⚠️ AskUserQuestion is a Claude-specific tool
  and cannot run under Codex. The request was cancelled.」
- 內部呼叫 `respondToApproval(id, "deny", "unsupported")`
- 不硬轉成 shell approval —— 那 UX 更爛

### plugins / hooks(Claude Agent SDK 專屬)

Codex 沒有 plugin / hook 系統。`CodexBackend` 直接**忽略**
`pluginRegistry.toSdkPluginConfig()` 和 `createPreToolUseHook()` —
它們留在 `ClaudeBackend.start()` 內部處理,`CodexBackend` 根本看不到。

### wakeup 機制

現有 wakeup queue 讓外部程式喚醒 Claude 繼續下一步。切到 codex backend
後 wakeup **依然運作**(payload 就是 prompt,backend-agnostic)。**唯一
注意**:wakeup env vars(`WAKEUP_CHANNEL_ID`, `WAKEUP_DIR`)目前透過
`env` 傳給 Claude SDK 子行程;`CodexBackend` spawn `codex app-server`
時也要傳同樣的 env。

### CLAUDE_MODEL

`CLAUDE_MODEL` env var 只給 Claude 用。Codex 有自己的 `--model` flag
(gpt-5 / gpt-5-mini / o3 等)。**現階段設計**:不新增 `CODEX_MODEL`
env var —— codex 直接吃 `~/.codex/config.toml`,減少 env 面板。未來
如果有需求再加。

### SHOW_COST

Codex app-server 未必回報 `total_cost_usd`。`NormalizedEvent.result.costUsd`
是 optional。**改進**:若 `costUsd === undefined`,`createResultEmbed()`
不顯示 cost row(避免顯示 "$0.00" 誤導使用者以為免費)。

### auto-approve

`auto-approve` 在 Claude 這邊是「跳過所有 approval」,codex 這邊等價。

**統一處理原則**:兩個 backend 都**照常 emit `tool_approval_request`
事件**,不在 backend 內部檢查 auto-approve。SessionManager 收到事件後
統一檢查 `getProject(channelId)?.auto_approve`,若為 true 就直接呼叫
`backend.respondToApproval(id, "allow")`,不顯示 Discord embed。

**為什麼統一在 SessionManager 而非 backend 內部**:
1. Backend 就不需要 import DB 層(維持 `src/agent/` 不碰 DB 的分層原則)
2. auto-approve 是 UX 決策(哪些工具跳過),不是 SDK 決策
3. 未來若加「per-tool auto-approve」功能只需改一處

## 分階段實作(給 writing-plans 參考)

建議分 4 個 milestone,每個都能獨立 merge、獨立 review:

### M1 —— Refactor without codex

抽出 `AgentBackend` interface、實作 `ClaudeBackend`、改造 `SessionManager`。
這階段結束後**功能跟現在完全一樣**,但架構準備好了。

Deliverables:
- `src/agent/backend.ts`
- `src/agent/claude-backend.ts`(把現有邏輯搬進來)
- `src/agent/backend-factory.ts`(此時只回 ClaudeBackend)
- 改造 `src/claude/session-manager.ts`
- Mock backend 整合測試(refactor 安全網)

Acceptance:所有既有測試綠、手動 smoke test 現有 Claude 流程正常。

### M2 —— Codex JSON-RPC client

寫 `codex-rpc.ts` + unit test。純協定實作,不接 Discord、不接
SessionManager。單獨可用、可測。

Deliverables:
- `src/agent/codex-rpc.ts`
- `src/agent/codex-rpc.test.ts`
- 一個 tiny CLI demo(`npm run codex-rpc-demo` 之類)可以手動連
  `codex app-server` 跑 hello world,供 M3 開發時 debug 用

Acceptance:單元測試覆蓋 frame codec、bidirectional request、chunk
boundary。demo 能真的送 initialize + thread/start + turn/start 拿到 result。

### M3 —— CodexBackend + `/codex` command

接上 M1 的 interface,加 DB migration、slash command、detect 邏輯。
這階段結束後**功能完整可用**。

Deliverables:
- `src/agent/codex-backend.ts`
- `src/agent/codex-detect.ts` + test
- `src/bot/commands/switch-backend.ts` factory
- `src/bot/commands/claude.ts` + `src/bot/commands/codex.ts`
- `src/bot/handlers/interaction.ts` 加 switch-backend button 處理
- DB migration
- `backend-factory.ts` 依 DB 回正確 backend
- 更新 README / SETUP 文件說明如何切換

Acceptance:能在 Discord 打 `/codex` 切過去,發訊息真的用 codex 跑,
tool approval 按鈕運作,`/stop` 有效,session resume 有效(送兩則訊息
第二則走 resume path)。

### M4 —— 打磨

- Cost display fallback(`costUsd === undefined` 不顯示)
- AskUserQuestion warning
- auto-approve 語意對齊
- 真實 codex end-to-end 測試(gated on `CI_HAS_CODEX`)
- Reasoning stream 顯示樣式(italics 或 spoiler)
- 更新 README / SETUP.kr.md

Acceptance:兩個 backend 都能跑 24 小時 dogfood 無 regression。

## Open questions(留給 implementation plan 決定)

1. `codex --version` 最低支援版本是什麼?低於這個要在 detect 階段就
   擋掉並提示升級。
2. `codex auth status` 這個指令是否真的存在?(研究時未直接驗證)
   —— 可能要改用 `codex config get` 或試探性跑 `thread/start`。
3. `codex-companion.mjs` 的具體路徑要在 M2 開發時確認(研究提到在
   Claude Code plugin cache 內)。
4. Reasoning delta 的顯示樣式(italic / spoiler / 折疊)—— M4 決定。
5. `M1 refactor` 前是否要先鎖版本 tag,方便有 regression 時
   `git bisect`。

## Risks

| 風險 | 影響 | 緩解 |
|---|---|---|
| Codex app-server 協定不穩定 | CodexBackend 隨 codex 升版壞掉 | 事件翻譯器單元測試 + M4 加真實 e2e 測試 gated on version |
| Async generator + eventQueue pattern 有 bug | 事件丟失或死鎖 | Mock backend 整合測試,加壓力測試(大量 approval 交替) |
| `respondToApproval` 忘記在 interrupt 時 resolve | SDK 卡住,`for await` 永不結束 | Section 4 明確列為 interrupt 責任;測試覆蓋 |
| 使用者切 backend 後 wakeup env 遺失 | 背景喚醒失敗 | M3 驗收時明確測 wakeup 在兩個 backend 都運作 |
| `session-manager.ts` refactor 引入 regression | 現有 Claude 使用者受影響 | M1 mock backend 整合測試,加手動 smoke checklist |

## Prior art / references

- 現有 spec:`2026-05-28-flush-stream-buffer-before-tool-design.md`(理解
  `flushStreamBuffer` 的存在原因)
- 現有 spec:`2026-05-16-skip-permissions-toggle-design.md`(理解
  `skipPermissions` 的語意)
- 現有 spec:`2026-06-01-wakeup-channel-design.md`(理解 wakeup 機制)
- Codex app-server 協定參考:
  <https://gist.github.com/oneryalcin/ee2c27e2d8aa040da8fbe7eebcc2ecea>
- `codex-companion.mjs`(Claude Code plugin 內建的 codex bridge,
  作為 JSON-RPC 實作範本)
