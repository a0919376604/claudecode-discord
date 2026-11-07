# R-003 DeepTutor 家教 backend — 規格

日期：2026-11-08
狀態：使用者已核准設計（2026-11-08，對話中逐段對齊）；本檔為 ship-next 規格

## 1. 目的與緣由

使用者想在 Discord 上擁有「家教頻道」：一個頻道綁一位家教（英文、日文、LeetCode……），
家教依使用者設定的目標（例如「雅思 7 分」、「30 分鐘內解出 LeetCode medium」）
**每天主動推播**一份小課表，使用者在頻道裡直接回答，家教批改、記錄弱點、讓錯題回鍋，
逐步把使用者推向目標。

不想另外開一個 Discord bot，所以整合進既有的 claudecode-discord：
它已經是「一個頻道 ↔ 一個 backend session」的架構，並且有排程器。
家教的「大腦」交給 DeepTutor（`/Users/leric/Desktop/code/DeepTutor`），
因為它的 `mastery_path` capability 已經有學習者檔案、知識點掌握度、出題 / 批改、間隔複習。

## 2. 使用者體驗（已與使用者對齊）

骨架（所有家教共用）：

1. **入門**：設定好家教後，第一則訊息就開始程度測驗、詢問程度與期限。
2. **倒推計畫**：依目標與期限排出學習路徑。
3. **每日推播**：在設定的時間推一份 10–15 分鐘的組合。
4. **立刻回饋**：使用者在頻道回答 → 家教批改、講解、打分。
5. **錯題回鍋**：答錯的內容依間隔重複再出現。
6. **每週小考 + 進度報告**：混合本週內容，給出朝目標的預估（例如「預估 6.0 → 6.5」）。

**每天練什麼由家教依弱點決定，但必須朝目標前進**（使用者決定，2026-11-08）。
DeepTutor 的學習路徑（知識點 + 掌握度 + 到期複習）是每日內容的主導者；
「菜單」降為**偏好**：入門時用來塑造大綱（例如英文大綱要有單字、文法、題型等模組），
每日推播時作為呈現風格的參考，不強制每天每類都出現。

「朝目標前進」的具體要求：每日推播 = 到期複習 / 弱點練習 **加上** 至少一步往下一個目標知識點的推進；
不能連續多天只在同一個弱點上打轉而沒有任何新進度（若某弱點卡太久，家教應換個方式教或暫時延後該知識點，
即 `mastery_defer_objective`，之後再回來）。

每位家教的菜單偏好示例。英文家教（已對齊）：

- 單字：每天 5–10 個新字（依目標挑字），隔天先考昨天的字，錯的進回鍋。
- 文法：一個小觀念 3–5 句 + 2 題練習；優先教使用者實際犯過的文法錯。
- 題目 / 考試：依目標出題（閱讀、寫作、口說先以打字作答）。
- 趣味遊戲：偶爾穿插（猜字、改錯句、限時造句）。
- 平日：單字 + 文法或題目；週末：小考 + 進度報告。

日文家教同骨架，多假名 / 漢字讀音；LeetCode 家教沒有「單字」，改為「題型觀念 + 每日一題」，
使用者回答時附上解題時間，超過目標時間的題型進回鍋，每週回報「目標時間內解出」的成功率。

範例推播（示意，非逐字規格）：

```
📅 Day 12 · 雅思 7 分計畫（目前預估 6.0 → 本週主攻 Writing Task 2）
🔥 連續 12 天
今日：5 個單字 · 文法「現在完成式 vs 過去式」· 一題 Task 2 開頭段
🔁 回鍋：上週錯的 affect / effect
```

## 3. 目標 / 非目標 / 反目標

**目標**
- 新 backend `deeptutor`，可用與 `/claude`、`/codex` 相同的方式切換到某頻道。
- `/tutor` 指令：設定科目、目標、菜單、每日推播時間，並建立每日與每週排程。
- 每日 / 每週推播透過既有排程器送進該頻道的 DeepTutor session；使用者回覆延續同一個 session。
- 出題能在 Discord 上看得到（題目與選項以文字呈現）。

**非目標（第一版不做）**
- 口說的語音輸入 / 發音評分。
- Discord 按鈕式作答（選擇題第一版用打字回答 A/B/C）。
- 連續天數 🔥 的精確計算若 DeepTutor 沒有現成資料，可先省略。
- DeepTutor 的 WebSocket 路徑（`deeptutor serve`）。第一版只用 CLI。
- 修改 DeepTutor 本體。

**反目標（技術上能跑但算失敗）**
- 推播變成一大段牆壁文字、手機上讀不完 —— 每日組合必須 10–15 分鐘內完成、適合手機閱讀。
- 家教不記得昨天教了什麼 / 錯了什麼，每天像第一次見面。
- 推播裡出現給 Claude 用的 preamble 或其他系統雜訊。
- 影響既有 Claude / Codex 頻道的行為。

## 4. 限制與已知事實（皆已在程式碼中驗證）

**claudecode-discord**
- `AgentBackend` 介面：`src/agent/backend.ts:45-52`；事件型別 `NormalizedEvent` 在 `:4-29`。
- backend 選擇：`src/agent/backend-factory.ts` 只判斷 `=== "codex"`，其餘走 Claude。
- `projects.backend` 允許值寫死為 `"claude" | "codex"`：`src/db/types.ts:9`、`src/db/database.ts:191-199`、`src/bot/handlers/interaction.ts:44-58`；
  `src/claude/session-manager.ts:179,409-410` 有 `backend === "codex"` 的三元判斷（非 codex 會套用 Claude 的 model/effort）。
- 切換指令由 `createSwitchBackendCommand(target)`（`src/bot/commands/switch-backend.ts`）產生；`codex.ts` 只有 3 行。
- 範本：`src/agent/codex-backend.ts`（spawn 子程序 → 翻譯事件 → queue → yield，`finally` kill 子程序）。
  NDJSON CLI 更簡單：`readline` 逐行 `JSON.parse` 後翻譯。
- session：`session-manager.ts:173-175` 讀 `resumeSessionId`；收到 `session_init` 時 `upsertSession`（`:435-438`）；
  `isResumeStaleError` 為真時不帶 resume 重跑（`:704-717`）。
- 排程：`Scheduler` 每 30 秒 `runTick` → wakeup JSON → `WakeupWatcher` → `sessionManager.wakeUp`（忙碌時 `enqueueWakeup`）。
  路徑本身不綁 backend，但 `wakeUp`（`session-manager.ts:898-916`）會加上 Claude 專用 preamble。
- 目前只有 Claude 的 `CronCreate` hook 能建立 cron；`/schedules` 只能 list / cancel / info。
  程式可直接 `insertCron()`（`src/db/crons.ts:19`）+ `nextFireAfter()`。單頻道上限 50 筆。
- `src/cron/parser.ts:10,18` 寫死 `tz: "UTC"`。
- 使用者回覆走 `handleMessage` → `sendMessage`，沿用同一 `session_id`；頻道忙碌時回覆會被詢問是否排入佇列。
- DB migration：新表在 `database.ts:14-87` 的 `CREATE TABLE IF NOT EXISTS`；新欄位用 `PRAGMA table_info` + `ALTER TABLE`。無版本號。
- 斜線指令：新檔 export `data` + `execute`，在 `src/bot/client.ts` import 並加入 `commands` 陣列；`execute` 內用 `editReply`。
  i18n `L(en, kr)`。
- 測試：vitest；`src/agent/mock-backend.ts`；可參照 `codex-translate.test.ts`、`codex-backend-lifecycle.test.ts`、
  `test/integration/schedule-end-to-end.test.ts`；DB 用 `__setDbForTests` + `:memory:`。

**DeepTutor**
- 執行：`deeptutor run mastery_path "<msg>" [--session <id>] --format json -l <lang>`，輸出 NDJSON，
  每行一個 `StreamEvent`（`deeptutor/core/stream.py`），type 有 `content`、`tool_call`、`tool_result`、`result`、`error`、`session`、`done` 等。
- session：不能自訂 id；第一次呼叫不帶 `--session`，新 id 出現在 `{"type":"session","metadata":{"session_id",...}}`，
  且每個事件頂層都有 `session_id`。帶不存在的 id 會報 `"Conversation not found"`（`services/session/turns/request_preparer.py:217-222`）。
- `mastery_path` 在沒有 `mastery_path_id` 時，以 session id 作為學習路徑的 key（`capabilities/mastery/capability.py:41-53`）。
  因此 **一個頻道 = 一個 DeepTutor session = 一條學習路徑**，CLI 即可運作。
- CLI 不能傳 `mastery_path_id` / `mastery_session_mode`；不傳 mode 時所有 mastery 工具都可用。`--config` 對 `mastery_path` 會被拒絕。
- `mastery_quiz` 出題後當輪結束，答案以下一則訊息送入，下一輪用 `mastery_grade` 批改 —— 正好對應 Discord 的「推一題、回答、批改」。
- `mastery_quiz` 的題目與選項是**工具呼叫參數**，不是 `content` 文字；CLI 的 rich renderer 也沒有特別顯示它。
  backend 必須把 `tool_call`（name=`mastery_quiz`）的參數轉成 Discord 可讀文字，否則使用者看不到題目。
- `--format json` 模式下 `ask_user` 會被自動回空字串（`deeptutor_cli/common.py:185-200`）。`mastery_quiz` 不依賴 `ask_user`，第一版可接受。
- 學習者檔案（目標、程度、時間、偏好）由 `mastery_profile` 工具寫入；掌握度、錯誤紀錄、複習佇列存在
  `<user>/workspace/learning/mastery.sqlite3`；間隔複習內建（`deeptutor/learning/scheduler.py`）。
- 前置：本機需安裝 DeepTutor（目前 `deeptutor` 不在 PATH）並設定好 LLM provider。

## 5. 已決定的「怎麼做」

- **分工**：DeepTutor 負責入門測驗、計畫、出題、批改、掌握度、錯題回鍋；claudecode-discord 負責 backend 接線、`/tutor` 設定、排程推播。（使用者已同意）
- **介面**：第一版透過 CLI（spawn `deeptutor run mastery_path ... --format json`），不走 WebSocket。（我的決定，使用者已同意分工提案）
- **入門測驗**：不另做 UI。（我的猜測，使用者未反對）
  - **我的決定**：DeepTutor 的入門提問走 `ask_user`（`prompts/en/mastery_loop.yaml` 的 `intake_needed`），在 CLI 下會被自動回空字串。
    因此由 `/tutor` 直接收「目標、期限、目前程度、每天可用時間」，帶進第一輪 prompt，要求家教用 `mastery_profile` 記下；
    prompt 也要求家教之後若需澄清，**用一般文字發問**，等使用者下一則訊息回答，不要用 `ask_user`。
- **session 保護（我的決定）**：DeepTutor session id 就是學習路徑的 key，遺失等於家教失憶。
  - 存一份在 `tutors` 表，一般的 session 重置（切 backend、`/sessions` 新建、resume 失敗自動重試）不得清掉它；每次執行以 `tutors` 表的 id 為準。
  - 遇到 `"Conversation not found"`：在頻道通知使用者並停止，不默默重建。
  - 只有明確的 `/tutor reset` 才開新路徑。
- **每週預估分數（我的決定）**：DeepTutor 沒有分數預測模型；由家教依掌握度與本週小考結果給出「粗估」，訊息中標明是粗估。
- **選擇題顯示（已查證）**：`mastery_quiz` 在登錄題目時打亂選項（`deeptutor/capabilities/mastery/tools.py:1587`），
  打亂後的題卡放在工具結果 metadata 的 `mastery_question` 鍵（`QUESTION_CARD_KEY`，`deeptutor/learning/question_card.py:38,57-82`；
  `tools.py:1519` `metadata = {"mastery_quiz": payload, "mastery_question": card}`），欄位：`question_id`、`prompt`、`question_type`、
  `objective{id,name}`、`difficulty`、`attempt`、`options[{label, body}]`，**不含**答案與解析。
  backend 必須從 `tool_result` 事件的 metadata 取這張題卡顯示（NDJSON 內的確切巢狀路徑以實跑或 DeepTutor 的 `deeptutor_cli/common.py`
  取 `ask_user` 的方式 `tool_result.metadata.tool_metadata.<key>` 為參考，實作時以 fixture 鎖定），**不得**用 `tool_call` 參數顯示選項。
- **菜單**以文字形式存在家教設定裡。入門 prompt 帶入菜單，讓 `mastery_build` 依此設計大綱模組；
  每日推播 prompt 只要求「依 `mastery_status`（到期複習、弱點）決定今天內容 + 往下一個目標知識點推進一步，菜單為偏好」，
  不逐項指定內容。改菜單後是否重建大綱：第一版不自動重建，由使用者在頻道裡直接跟家教說。

## 6. 範圍（本次 ship）

1. `src/agent/deeptutor-translate.ts`：純函式，DeepTutor NDJSON 事件 → `NormalizedEvent[]`，含題卡轉文字。
2. `src/agent/deeptutor-backend.ts`：`AgentBackend` 實作，spawn `deeptutor run mastery_path <prompt> [--session <id>] --format json`，
   逐行解析；session id 以 `tutors` 表為準（見 Decisions）。
3. `tutors` 表 + `src/db/tutors.ts` CRUD。
4. `Project.backend` 型別加入 `"deeptutor"`；`backend-factory.ts` 回傳 `DeepTutorBackend`；session-manager 對 deeptutor 不傳 Claude model/effort。
5. `wakeUp` 對 `deeptutor` backend 不加 Claude preamble。
6. `/tutor` 斜線指令：`setup`、`show`、`reset`、`pause`（見 Decisions）。
7. 推播時間 → UTC cron 換算 + 每日 / 每週兩筆 `crons` 列（`name` 標記 `tutor:daily` / `tutor:weekly`）。
8. 測試：翻譯函式、backend 生命週期（假 CLI 腳本）、tutors CRUD、時間換算、`/tutor setup` 建立的列、`wakeUp` 無 preamble。

## Seams

| Seam | Interface | Guaranteed behavior |
|---|---|---|
| DeepTutor CLI → bot | 子程序 stdout NDJSON，每行一個 `StreamEvent` JSON | 非 JSON 行忽略不中斷；子程序非 0 結束且未收到 `result` 時，產生一個 `isError: true` 的 `result` |
| `translateDeepTutorEvent(ev)` | `(ev: unknown) => NormalizedEvent[]` 純函式 | `content` → `text_delta`；`session`（或首個帶 `session_id` 的事件）→ `session_init`；`tool_call` → `tool_start`；`tool_result` → `tool_end`，若 metadata 帶 `mastery_question` 題卡則另產生一段 `text_delta`（題目 + 打亂後選項，不含答案）；`error` → `result{isError:true}`；`result`/`done` → `result{isError:false}`；未知 type → `[]` |
| `DeepTutorBackend` | `AgentBackend`（`src/agent/backend.ts`） | 每次 `start` 至多一個 `result`；`interrupt()` 終止子程序；`respondToApproval` / `respondToQuestion` 為 no-op；`isResumeStaleError` 永遠 `false`；`"Conversation not found"` 轉成使用者可讀的錯誤 `result`，不自動開新 session |
| `tutors` 表 / `src/db/tutors.ts` | `getTutor(channelId)`、`upsertTutor(row)`、`setTutorSession(channelId, sessionId)`、`deleteTutor(channelId)` | 一頻道一列（`channel_id` PK，FK → `projects` CASCADE）；`deeptutor_session_id` 只被 `setTutorSession`（首次取得）與 `/tutor reset` 改動 |
| `localTimeToUtcCron(hhmm, tz, dow?)` | 純函式 → 5 欄 cron 字串（UTC） | 依「目前」時區偏移換算；跨日時調整星期欄 |
| `/tutor` 指令 | discord.js `SlashCommandBuilder`，`setup` / `show` / `reset` / `pause` | `setup` 寫 `tutors`、把 `projects.backend` 設為 `deeptutor`、重建該頻道 `tutor:*` cron（不動其他 cron）、送出入門第一輪；`pause` 只刪 `tutor:*` cron |
| `SessionManager.wakeUp` | 既有 | `deeptutor` backend 時 prompt 原樣送出，不加 preamble；其他 backend 行為不變 |

## Decisions

- Door: one-way — 新增 SQLite 表（schema 變更）且排程會主動發訊息給使用者。
- 使用者決定：每日內容由家教依弱點決定、但每天必須往下一個目標知識點推進；菜單只是偏好（2026-11-08）。
- 使用者決定：分工 —— DeepTutor 是大腦，claudecode-discord 只做接線 / 設定 / 排程。
- 使用者決定：第一版不做語音口說、不做按鈕作答。
- 我的決定：只用 CLI，不走 WebSocket；入門資料由 `/tutor setup` 參數收集（`ask_user` 在 CLI 會被回空字串）。
- 我的決定：不新增 `/deeptutor` 切換指令；`/tutor setup` 直接把頻道 backend 設為 `deeptutor`。用既有 `/claude`、`/codex` 切走時，`tutors` 列保留，再次 `/tutor setup` 會沿用原 DeepTutor session（學習進度不丟）。
- 我的決定：session 保護 —— backend 以 `tutors.deeptutor_session_id` 為準，忽略 `opts.resumeSessionId`；`isResumeStaleError` 恆 `false`，避免 session-manager 的「resume 失敗就開新 session」路徑讓家教失憶。
- 我的決定：時區不改 `cron/parser.ts`（避免動既有排程語意），在 `/tutor setup` 時把當地時間換成 UTC cron；預設 `Asia/Taipei`。有夏令時間的時區會在換季後偏一小時（`ponytail:` 註解標明上限與升級路徑：替 crons 加 tz 欄位）。
- 我的決定：`/tutor setup` 參數：`subject`（必填）、`goal`（必填）、`level`、`deadline`、`daily_minutes`、`menu`、`time`（預設 `08:00`）、`timezone`（預設 `Asia/Taipei`）、`language`（DeepTutor `-l`，預設 `zh`）。每週報告固定週日同一時間。
- 我的決定：`DEEPTUTOR_BIN` 環境變數（預設 `deeptutor`），加入 `src/utils/config.ts` 為可選。
- 我的決定：每週預估分數由家教粗估並標明「粗估」。
- 我的決定：頻道必須先 `/register`（沿用既有專案綁定；`cwd` = 專案目錄）；`/tutor setup` 在未註冊頻道上回覆錯誤。

## 7. 留給實作者決定

- 入門 / 每日 / 每週 prompt 的確切措辭（須符合第 2 節與 Decisions：每日 = 到期複習或弱點 + 至少往下一個目標推進一步；
  需要澄清時用一般文字發問、不用 `ask_user`；每週給「粗估」）；英文 / 日文 / LeetCode 的預設菜單模板。
- 題卡轉文字的排版（手機友善；選擇題列 `A. body`，請使用者打字回答）。
- `getAuthErrorHint`：辨識 `deeptutor` 不存在（ENOENT）與 LLM 未設定的訊息。
