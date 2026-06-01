# Wake-up Channel for claudecode-discord

**日期**:2026-06-01
**作者**:brainstorm with Claude
**狀態**:approved, ready for implementation plan

---

## Problem

`/run-plan` skill 在原生 Claude Code 終端機 harness 裡可以靠 `Monitor` /
`ScheduleWakeup` / OS notification 在 codex 完成時把 Claude 叫醒、跑 Step 7
驗證、用 Discord `reply` 工具回報。

在 claudecode-discord(Discord bot + Claude Agent SDK)環境裡這四條通道全部
斷掉:

1. `Monitor` tool 不存在於 Agent SDK
2. `ScheduleWakeup` 是 Claude Code harness 的能力,Agent SDK 沒有
3. OS notification 只通知本機,使用者通常在 Discord(手機/桌面)而非 bot 主機旁
4. Step 7 的「Discord reply」需要 Claude 還活著,但 `SessionManager.sendMessage()`
   的 `query()` 在 codex 被 `nohup` 出去後早就回傳、走 finally 把 session 清掉了

結果:codex 在背景默默跑完、寫了 done marker、發了本機通知 —— **但 Discord
channel 永遠收不到完成訊息,使用者要等到下次自己打字才會發現**。

`/tmp/run-plan-done-<slot>.txt` 這個保險機制存在,但它依賴未來某次 Claude
session 主動呼叫 `/run-plan status` 才會被消化,使用者不打字就不會發生。

## Root cause

Skill 設計把「我會在 Claude Code 終端機 harness 裡跑」當前提。在 Agent SDK
裡跑時,「外部事件 → 喚醒 Claude」這條鏈缺一個 harness 級別的執行者來把
codex 完成事件轉化為一次新的 Claude turn。

這不是 /run-plan 的 bug,也不是 claudecode-discord 的 bug。是兩者之間缺一個
**wake-up channel** —— 一個讓背景程式可以「外部觸發 Claude session」的介面。

## Solution

在 claudecode-discord bot 內新增 `WakeupWatcher` 模組,扮演 harness 的角色:

- 監聽一個約定的 wake-up 目錄,任何外部程式丟 JSON 進來就觸發
- 對應到註冊在 bot 的 Discord channel
- 開新的 Claude session 把合成的 prompt 餵給 SessionManager,讓 Claude 正常
  回應(走原本的 streaming → Discord 路徑)

同時對 `/run-plan` skill 做最小變動:在原本寫 done marker 之後,額外寫一個
wake-up JSON 進來。**Skill 本身完全不需要懂 Discord** —— bot 透過環境變數注入
所需的 channel id 與 wake-up dir 路徑,skill 只要原樣轉寫即可。

這個機制刻意做成通用的:未來任何 long-running 背景工作(CI watcher、build
watcher、long-running tests)都可以透過同一條 channel 喚醒 Claude。

## Design

### Architecture overview

```
┌─────────────────────────────────────────────────────────────────┐
│ Bot 啟動                                                         │
│   ├── mkdir -p ~/.claudecode-discord/wakeups (chmod 700)        │
│   ├── WakeupWatcher.start()                                     │
│   │     ├── fs.watch(~/.claudecode-discord/wakeups/)            │
│   │     ├── fs.watch(/tmp) → run-plan-done-*.txt (legacy adapter)│
│   │     └── startup scan: 處理開機前累積的事件                   │
│   └── 一般 message handler 走原本路徑                            │
└─────────────────────────────────────────────────────────────────┘
                       │
                       ▼ 新 wake-up 事件
┌─────────────────────────────────────────────────────────────────┐
│ WakeupWatcher.handleEvent(payload)                              │
│   1. 解析 + 驗證 JSON schema                                     │
│   2. channel_id 必須在 projects 表內(否則丟棄+log)              │
│   3. TTL 過期 → 丟棄+log                                         │
│   4. 立即發 passive Discord embed(🎯 source + summary)          │
│   5. 該 channel 有 active session?                              │
│        否 → SessionManager.wakeUp(channelId, prompt, source)    │
│        是 → INSERT INTO wakeup_queue                            │
│   6. 刪除 wake-up dir 內的觸發 JSON 檔                           │
│      (/tmp/run-plan-done-*.txt 不刪 — 那是 skill 自己的狀態,     │
│       由 /run-plan Step 7 自行清理)                              │
└─────────────────────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│ SessionManager.wakeUp(channelId, prompt, source)                │
│   ├── 走跟使用者訊息一樣的 query() 流程                          │
│   ├── prompt 內嵌合成的 Discord channel context tag             │
│   │   (讓 /run-plan Step 7 能 scan 到並走 Discord reply 路徑)   │
│   ├── Streaming 回覆走原本路徑送回 Discord                       │
│   └── finally:檢查 wakeup_queue,有待處理項目就遞迴 wakeUp      │
└─────────────────────────────────────────────────────────────────┘
```

### Wake-up payload schema

寫到 `~/.claudecode-discord/wakeups/<uuid>.json`:

```typescript
interface WakeupPayload {
  channel_id: string;        // 必填,Discord channel id(snowflake)
  prompt: string;            // 必填,要塞給 Claude 的訊息(限長 4000 字元)
  source: string;            // 必填,來源識別,例:"run-plan" / "ci-watcher"
  metadata?: Record<string, unknown>;  // 任意,bot 不解讀,僅供 log/embed
  created_at: string;        // ISO 8601
  ttl_seconds?: number;      // 預設 86400(24h),過期丟棄
}
```

**寫入流程要求:** 寫到 `<uuid>.json.tmp` 後 `rename` 成 `<uuid>.json`,確保
fs.watch 看到時是完整檔(原子寫入,避免讀到半寫狀態)。

### Legacy adapter(`/run-plan` 不必大改)

Bot 額外 watch `/tmp` 目錄,只關心檔名 pattern `run-plan-done-*.txt`。
看到新檔出現時:

1. 讀對應 `/tmp/run-plan-meta-<slot>.txt`
2. 從 meta 拿 `channel_id`(由 bot 在 launch query() 時注入的 `WAKEUP_CHANNEL_ID`
   env var 寫進去)
3. 合成 `WakeupPayload`:
   ```json
   {
     "channel_id": "<from meta>",
     "prompt": "/run-plan status <slot>",
     "source": "run-plan",
     "metadata": { "slot": "<slot>", "status": "<done file status>", "commits": "+<n>" },
     "created_at": "<ISO 8601 now>"
   }
   ```
4. 走跟 native wakeup 一樣的 `handleEvent` 流程
5. 處理完不刪 `/tmp/run-plan-done-*.txt`(那是 skill 自己的狀態,讓 Step 7 自行清)

**Meta file 沒有 channel_id 怎麼辦?** 例如使用者手動跑 `/run-plan` 沒透過
bot session。Adapter log warning 後跳過,維持現有行為(只有 OS notification)。

### `/run-plan` skill 端最小變動

兩處修改,加總約 15 行:

**A. Step 4 heartbeat watcher 結尾,寫完 done marker 之後新增:**

```bash
if [ -n "$WAKEUP_CHANNEL_ID" ] && [ -n "$WAKEUP_DIR" ] && [ -d "$WAKEUP_DIR" ]; then
  WAKEUP_UUID=$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid 2>/dev/null)
  WAKEUP_FILE="$WAKEUP_DIR/$WAKEUP_UUID.json"
  cat > "$WAKEUP_FILE.tmp" << WAKEUP_JSON_END
{
  "channel_id": "$WAKEUP_CHANNEL_ID",
  "prompt": "/run-plan status $SLOT",
  "source": "run-plan",
  "metadata": {"slot": "$SLOT", "status": "$FINAL_STATUS", "commits": "+$FINAL_COMMITS"},
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
WAKEUP_JSON_END
  mv "$WAKEUP_FILE.tmp" "$WAKEUP_FILE"
fi
```

未設定環境變數時整段跳過,維持現有行為(完全 backward compatible)。

**B. Step 3 launch 時把 env var 寫進 META_FILE(供 legacy adapter fallback 使用):**

```bash
echo "channel_id=${WAKEUP_CHANNEL_ID:-}" >> "$META_FILE"
```

### Bot 端 env var 注入

`SessionManager.sendMessage()` 透過 Agent SDK 啟動 query() 時,設定:

- `WAKEUP_CHANNEL_ID=<discord channel id>`
- `WAKEUP_DIR=<absolute path of ~/.claudecode-discord/wakeups>`

Skill 端原樣繼承這兩個 env。沒有設(在非 claudecode-discord 環境跑 /run-plan)
時 skill 跳過寫 wake-up file,行為退回到只發 OS notification + 寫 done marker。

### Conflict handling(對應 hybrid 策略)

| 情境 | 行為 |
|---|---|
| Channel 無 active session | 立即 `SessionManager.wakeUp()`,使用者看到 Claude 開始驗證 |
| Channel 有 active session | 1. 立即發 passive Discord embed(不打斷對話)<br>2. INSERT INTO `wakeup_queue`<br>3. SessionManager 當前 session 的 finally 處理 queue |
| Channel 未註冊 | 丟棄 + log warning(不發訊息,避免 spam) |
| TTL 過期 | 丟棄 + log |
| Bot 處理 wakeup 時 crash | 觸發檔還在 → restart 後 startup scan 補做 |
| 同 source+slot 重複 wakeup | dedupe by `source + metadata.slot`,只保留最新一筆 |
| Queue 累積過多(>5 筆) | 同 source 只保留最新一筆,丟棄舊的 + log |

### Passive Discord embed 格式

當 channel 有 active session 時立即送出:

```
🎯 背景任務完成 — run-plan / refactor-foo
狀態:DONE
新增 commits:+7
當前對話結束後會自動進入驗證
```

Embed 用 source-aware 模板(/run-plan 顯示 slot/status/commits;其他 source
顯示 source + metadata key/value)。

### Database schema 變更

新增一個 table:

```sql
CREATE TABLE IF NOT EXISTS wakeup_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  source TEXT NOT NULL,
  payload_json TEXT NOT NULL,           -- 序列化的 WakeupPayload
  queued_at INTEGER NOT NULL,           -- unix ms
  dedupe_key TEXT,                       -- source + metadata.slot,用於 dedupe
  UNIQUE(channel_id, dedupe_key)         -- 同 channel 同 dedupe key 只留一筆
);
CREATE INDEX IF NOT EXISTS idx_wakeup_queue_channel ON wakeup_queue(channel_id, queued_at);
```

`dedupe_key` 在 wake-up 進 queue 時計算:`<source>:<key>`,其中 `<key>` 規則:
1. 若 `metadata.slot` 存在 → 用 `metadata.slot`
2. 否則 → 對 `metadata` 做 canonical JSON stringify(key 字典序排序)後取 sha256 前 16 hex
3. 若 metadata 為空 → 用 `created_at`(這種情況不該 dedupe,實際上是 noop)

### 模組結構

**新增檔案:**

| 路徑 | 職責 |
|---|---|
| `src/claude/wake-watcher.ts` | fs.watch 兩個目錄、解析 payload、分發到 SessionManager / queue |
| `src/db/wakeup-queue.ts` | `wakeup_queue` table CRUD |

**修改檔案:**

| 路徑 | 變更 |
|---|---|
| `src/index.ts` | 啟動時呼叫 `WakeupWatcher.start()`、確保 wake-up dir 存在(chmod 700) |
| `src/claude/session-manager.ts` | 新增 `wakeUp(channelId, prompt, source)` method;sendMessage finally 加 queue 檢查;query() 啟動時注入 `WAKEUP_CHANNEL_ID` + `WAKEUP_DIR` env |
| `src/db/database.ts` | 加 `wakeup_queue` 建表 SQL |
| `src/db/types.ts` | 加 `WakeupQueueRow` 型別 |
| `src/utils/config.ts` | 加 `WAKEUP_DIR_OVERRIDE` 可選環境變數(測試用) |

### Security

- Wake-up dir 權限 `chmod 700`(只 owner 可讀寫)
- Payload schema 嚴格驗證(zod):
  - `channel_id` 必須是 Discord snowflake 格式(17-20 digit numeric string)
  - `prompt` 限長 4000 字元(避免被當作 DoS 向量)
  - `source` 限制為 `[a-z0-9_-]+`,最長 64 字元
  - `created_at` 必須是合法 ISO 8601
- Wake-up 觸發的 session 視同 channel 註冊使用者的請求,套用同樣的
  `src/security/guard.ts` rate limit 與權限模型
- Wake-up dir 內檔案處理完立即刪除,避免敏感 prompt 殘留
- **不從外部 HTTP/network 接受 wake-up** —— 只認本機檔案系統,大幅縮小攻擊面

### Failure modes

| 失敗模式 | 處理 |
|---|---|
| Payload JSON 解析失敗 | 移到 `~/.claudecode-discord/wakeups/.rejected/`,log warning(便於 debug) |
| Schema 驗證失敗 | 同上 |
| 開檔權限錯誤 | log error,跳過該檔案 |
| Bot 寫 Discord 訊息失敗(API 錯誤) | retry 3 次後 log error,wake-up 檔保留以便下次 startup scan 補做 |
| `SessionManager.wakeUp()` 過程中 query() 拋例外 | 同一般 user message 的錯誤處理路徑,發錯誤訊息到 Discord |
| Watcher 自身崩潰 | 寫到 process 主要錯誤通道,讓 bot 整個崩潰並重啟(systemd / pm2 / 使用者重啟)以保持系統健康狀態 |

### Cross-platform 考量

- **macOS / Linux:** `fs.watch` 原生支援 directory watching,事件即時
- **Windows:** `fs.watch` 在 Windows 上對新建檔的事件有 known issue
  (有時 fire `rename` 而非 `change`),WakeupWatcher 同時處理兩種事件
  類型 + 在每次事件後 readdir 補做完整掃描(代價極小,目錄通常 < 10 個檔)
- 路徑一律 `path.join` / `path.resolve` 處理(跨平台)
- `~` 展開用 `os.homedir()` 不依賴 shell

### Test strategy

(test stack:vitest,與專案 npm test 一致)

**Unit:**

- `WakeupPayload` schema 驗證(zod)各種 malformed input
- `WakeupWatcher.handleEvent` 各種情境:
  - 合法 payload + active session → 進 queue
  - 合法 payload + idle session → 呼叫 wakeUp()
  - 未註冊 channel → 丟棄
  - 過期 TTL → 丟棄
  - 重複 dedupe_key → 取代舊的
- Legacy adapter:模擬 `/tmp/run-plan-done-X.txt` 出現 → 合成正確 payload
- DB layer:`wakeup_queue` CRUD + dedupe constraint

**Integration:**

- 啟動 WakeupWatcher → 寫合法 JSON 到 wake-up dir → 確認觸發
- Startup scan:預先放 JSON 再啟動 → 確認被處理
- Active session + wake-up → 確認 passive embed 先送、session 結束後 queue 被消化

**E2E(手動 happy path):**

- 註冊 channel + 在 channel 發 `/run-plan` → 等 codex 完成 → 確認 Discord
  channel 收到 passive embed + 驗證訊息

**Legacy adapter 回歸測試:** 模擬 /run-plan skill 寫的 `/tmp/run-plan-done-*.txt`
+ meta file → 確認轉成 wakeup event 並走 happy path。

## Acceptance criteria

1. **AC-001** 在 Discord channel 發起 `/run-plan` → codex 在背景完成 → 同個
   Discord channel **自動**收到完成通知,中間使用者不必打任何字
2. **AC-002** Active session 進行中時收到 wakeup → 立即看到 passive embed,
   當前對話不被中斷;當前對話結束後自動觸發驗證 session
3. **AC-003** Bot 重開機後仍能處理 downtime 期間累積的 wake-up 事件
4. **AC-004** Wakeup channel 對 channel_id 註冊狀態、TTL、schema 不合法做防禦,
   不註冊的 channel 被靜默丟棄
5. **AC-005** `/run-plan` skill 在非 claudecode-discord 環境下行為不變
   (沒設 env var 時跳過寫 wake-up file)
6. **AC-006** Wake-up 檔系統為本機 only,不接受網路 wake-up
7. **AC-007** 任何其他 skill 只要寫一個合法 JSON 到 `$WAKEUP_DIR` 就能觸發
   喚醒(用 `echo + jq` 或同等工具,< 5 行 shell)

## Out of scope

- 多 PC 跨機器 wake-up(每台 PC 跑自己 bot,各自管自己的 wake-up dir)
- HTTP/webhook 介面(本期只做檔案系統介面,未來可加但不在這個 spec)
- Wake-up 優先級 / 排程(FIFO 就夠)
- Tray 應用整合(tray 已有自己的更新邏輯,wake-up 是 bot 內建能力)
- 更改 /run-plan skill Step 7 的 Discord reply 邏輯(那段保留,在 wake-up
  spawn 的 session 裡正常運作)
