# Harness Scheduling Bridge for claudecode-discord

**日期**:2026-07-13
**作者**:brainstorm with Claude
**狀態**:approved, ready for implementation plan

---

## Problem

Claude Code harness 提供一組「時序 / 主動」工具讓 Claude 可以自主觸發自己或
使用者:

| 工具 | 用途 |
|---|---|
| `ScheduleWakeup` | 一次性延時,N 秒後 harness 重新叫醒 Claude 跑一段 prompt |
| `CronCreate` / `CronList` / `CronDelete` | Unix cron 表達式的重複排程 |
| `PushNotification` | 主動推播訊息給使用者 |

在原生 Claude Code CLI(long-lived process)這些工具正常運作 —— harness 就是
CLI 本身,它把排程存進記憶體,時間到就 re-invoke Claude turn。

**在 claudecode-discord 這條路徑上,四個工具全部 dead-on-arrival:**

1. Bot 透過 `@anthropic-ai/claude-agent-sdk` 的 `query()` 生一次性子行程
2. Claude 呼叫 `ScheduleWakeup(300)` → harness 收到、排程進進程記憶體、
   回 `"Next wakeup scheduled..."` 給 Claude
3. Claude `end_turn` → SDK 收到 `result` → `session-manager.ts:635` `break`
4. **子行程 EXIT** → 排程資料隨進程消失
5. 5 分鐘後 —— 什麼都沒發生。使用者以為 Claude 會回來 check,結果永遠不會

實際案例(2026-07-12 UTC,ai-eden-service session `24f13f8a-...`):
- `16:11:58` Claude 呼叫 `ScheduleWakeup(delaySeconds=300)`,排定 `16:16:58` 觸發
- `16:12:02` Claude 說「Run 1 attempt 5 launched (pid 21103) @ 00:11。等 5 min。」
- `16:16:58` 應觸發時間 —— **沒有任何事發生**
- 使用者手動打「Hi」進來,才把 session resume 起來繼續 check

旁證:`~/.claudecode-discord/wakeups/` 空、`wakeup_queue` DB table 空、
`~/.claude/session-env/24f13f8a-.../` 空 —— 全機器找不到任何 ScheduleWakeup
的持久化狀態。

## Root cause

`ScheduleWakeup` 假設 **harness 是長駐進程**,把排程存在進程記憶體。SDK 模式
下,每個 turn 完 subprocess 就死,harness 消失。工具**看起來成功**(Claude 收
到 `"Next wakeup scheduled..."` 訊息、`end_turn` 正常),但實際上排程無效。

這不是任何一方的 bug:harness 沒錯(它假設自己活著)、SDK 沒錯(它 turn-
based)、bot 沒錯(它照 SDK 契約收 result)。是**三者交界處缺一個橋接層**。

## Solution

在 bot 內新增一個 harness scheduling bridge,把 Claude 想用的排程工具攔截下
來,轉譯成 bot 自己管理的持久化排程。核心設計三件事:

1. **PreToolUse hook** 攔截五個 harness 工具,寫進 bot 的 DB,回假 tool_result
   給 Claude(讓 Claude 以為 harness 幫他排了)
2. **Scheduler daemon** 常駐 in-process,每 30s tick 一次,把 DB 到期的排程
   翻譯成 wakeup file
3. **復用**現有 `WakeupWatcher` 消化 wakeup file → 開/resume Claude session

## Design

### Architecture overview

```
┌─ Discord ─────────────────────────────────────────┐
│  User ← channel messages ← Bot                     │
│                              │                     │
│                              ▼                     │
│                         SessionManager             │
│                              │                     │
│  ┌───── Claude Subprocess (via SDK) ─────┐         │
│  │                                        │         │
│  │  Claude → ScheduleWakeup(...)        │         │
│  │            ↓ PreToolUse hook 攔截 ★  │         │
│  │            ↓ 寫 DB + 回假 success   │         │
│  │            ↓                          │         │
│  │  Claude ← "已排程" ← 假結果         │         │
│  │  Claude → end_turn → result → EXIT    │         │
│  └────────────────────────────────────────┘         │
│                              │                     │
│                              ▼                     │
│  ┌── Scheduler Daemon (bot 常駐) ────────┐         │
│  │  每 30s tick:                          │         │
│  │  1. 讀 schedules table                 │         │
│  │  2. 過 TTL 的 → 發 miss 通知 + 刪除    │         │
│  │  3. 到時的 → 寫 wakeup file            │         │
│  │  4. 讀 crons table → 計算 next fire   │         │
│  │  5. 到時的 → 寫 wakeup file + 更新    │         │
│  └────────────────────────────────────────┘         │
│                              │                     │
│                              ▼                     │
│  ┌── WakeupWatcher (現有) ───────────────┐         │
│  │  監聽 ~/.claudecode-discord/wakeups/  │         │
│  │  → wakeUp(channelId, prompt, source)  │         │
│  │  → resume Claude session             │         │
│  └────────────────────────────────────────┘         │
└────────────────────────────────────────────────────┘
```

三個新元件,一個復用點。三者職責清楚不重疊:

- **PreToolUse hook** — 把 Claude 的排程意圖持久化,不管觸發
- **Scheduler daemon** — 時序判斷,不管 Claude 執行
- **WakeupWatcher (現有)** — 觸發 Claude session,不管排程來源

### PreToolUse hook 的五個工具攔截

Hook 在 `session-manager.ts` 的 `query()` options 註冊。SDK types
(`sdk.d.ts:1318`、`sdk.d.ts:3200`)明確保證 PreToolUse hook 會在 canUseTool
之前執行,而且**即使 `allowDangerouslySkipPermissions` 開著也會觸發**,故不受
使用者 skip-permissions 設定影響。

#### `ScheduleWakeup` — 一次性排程

**輸入**(從 tool_use log 觀察):
```json
{ "delaySeconds": 300, "prompt": "Check R-018...", "reason": "..." }
```

**Hook 動作**:
1. 產生 `scheduleId = "sch_" + randomUUID().slice(0,8)`
2. 計算 `fireAt = now + clamp(delaySeconds, 60, 3600) * 1000`
3. `INSERT INTO schedules` (見 4.1),`source = "schedule_wakeup"`
   (**lowercase** — 對應 `WakeupPayloadSchema` 的 `regex(/^[a-z0-9_-]+$/)`)
4. 回傳假 tool_result 給 Claude:
   ```
   Next wakeup scheduled for HH:MM:SS (in Ns). Bot will re-invoke you when
   the wakeup fires. (id: sch_xxx)
   ```
5. 短路 tool call,Claude 不會呼到真的 harness `ScheduleWakeup`

#### `CronCreate` — 重複排程

**推測輸入**:
```json
{ "schedule": "0 9 * * *", "prompt": "...", "name": "早會 PR 摘要" }
```

**Hook 動作**:
1. 用 `cron-parser` 驗證 cron_expr,invalid → 回錯誤讓 Claude 修正
2. `INSERT INTO crons` (見 4.2),`next_fire = cronParser.parseExpression(expr).next()`
3. 回 `"Cron created (id: cron_xxx). Next fire: <ISO>"`

#### `CronList`

Hook `SELECT * FROM crons WHERE channel_id = ?`,格式化成表格字串回 Claude。
不 call harness(harness 每 turn 都是新 process,list 出來是空的沒用)。

#### `CronDelete`

Hook `DELETE FROM crons WHERE id = ? AND channel_id = ?`,回 `"Deleted cron_xxx"`
或 `"Not found in this channel"`。

#### `PushNotification` — 主動推播

**推測輸入**:
```json
{ "message": "任務 X 完成", "priority": "normal|high" }
```

**Hook 動作**:
1. `channel.send({ content: message })` —— **不加 @mention**(使用者確認 Discord
   channel 已設 All Messages notification,新訊息就 push)
2. 回 `"Notification sent"`
3. 不寫 DB(即時動作,不是排程)

#### Hook 通用機制

SDK types 已確認(`sdk.d.ts:1999-2005`、`sdk.d.ts:5540-5554`):

```ts
type PreToolUseHookSpecificOutput = {
  hookEventName: 'PreToolUse';
  permissionDecision?: 'allow' | 'deny' | 'ask' | 'defer';
  permissionDecisionReason?: string;
  updatedInput?: Record<string, unknown>;
  additionalContext?: string;
};

type SyncHookJSONOutput = {
  continue?: boolean;
  suppressOutput?: boolean;
  systemMessage?: string;
  decision?: 'approve' | 'block';
  reason?: string;
  // hookSpecificOutput 見 SDK types 5553 行後續
};
```

**主要嘗試策略**:回 `permissionDecision: 'deny'` + `permissionDecisionReason`
包含完整假 result 字串(如 `"Next wakeup scheduled for..."`)。deny 讓 tool 不
執行,reason 是 Claude 收到的訊息。實測確認 Claude 對這種「deny 但 reason 是
正面訊息」的反應是否 acceptable(不會 loop retry)。

**退路方案 A**:若 deny+reason 會被 Claude 當成錯誤 retry,改用 `updatedInput`
把 `delaySeconds` 改成 harness 支援的最小值,讓 harness 自己排;bot 這邊寫 DB
也存一份,tick 時擇一觸發(harness fire 因為進程死掉不會發生,只有 bot 這邊
會 fire)。缺點:harness 端會殘留 in-memory 排程,無效但存在。

**退路方案 B**:`additionalContext` 塞 "wakeup id: sch_xxx" 讓 Claude 有 context,
再讓 harness 正常執行(反正 harness 死了也沒差),bot DB 這邊做真的排程。缺點:
Claude 看到兩則訊息(harness 的 + hook 的),可能困惑。

實作時第一個 PoC 是主要策略,失敗才走退路。

### Scheduler daemon 時序邏輯

**為什麼是 30s tick 而不是 setTimeout**:

| 方式 | 優 | 缺 |
|---|---|---|
| 每 schedule 一個 setTimeout | 精準到 ms | Bot 重啟全丟、rehydrate 複雜、取消要清 timer |
| 30s 掃 DB (採用) | 天然抗重啟/當機/休眠、取消只要 DELETE | ±30s 精度 |

`ScheduleWakeup` 最小 delay 60s,±30s 可接受;cron 本來就分鐘級,精度綽綽有餘。
拒絕混合策略 —— 兩套時序共存 bug 面積更大。

**Tick pseudocode**:

```typescript
async function tick(now: number) {
  if (running) return;   // 上一輪還沒完 → skip
  running = true;
  try {
    // schedules (once)
    const expired = db.prepare(`
      SELECT * FROM schedules
      WHERE created_at + ttl_seconds * 1000 < ?
    `).all(now);
    if (expired.length > 0) {
      sendMissBundle(expired);   // 合併成一條 miss 通知
      deleteRows(expired);
    }

    const due = db.prepare(`
      SELECT * FROM schedules
      WHERE fire_at <= ? AND created_at + ttl_seconds * 1000 >= ?
    `).all(now, now);
    for (const row of due) {
      try {
        writeWakeupFile(row);
        db.prepare(`DELETE FROM schedules WHERE id = ?`).run(row.id);
      } catch (e) { logAndContinue(e, row); }
    }

    // crons (recurring)
    const dueCrons = db.prepare(`SELECT * FROM crons WHERE next_fire <= ?`).all(now);
    for (const row of dueCrons) {
      try {
        writeWakeupFile(row);
        const nextFire = cronParser.parseExpression(row.cron_expr, { currentDate: now }).next().getTime();
        db.prepare(`UPDATE crons SET last_fire = ?, next_fire = ? WHERE id = ?`)
          .run(now, nextFire, row.id);
      } catch (e) { logAndContinue(e, row); }
    }
  } finally {
    running = false;
  }
}
```

**啟動**:`bot/client.ts` 起手時 `scheduler.start()` → 立即做一次 tick(補跑
漏掉的)→ 設 `setInterval(tick, 30_000)`。

**停止**:`bot/client.ts` graceful shutdown 時 `scheduler.stop()`。

**為什麼寫 wakeup file 而不是直接 call `wakeUp()`**:
復用現有 `WakeupWatcher` 的 active-session queue-up、payload 驗證、rejected
隔離、embed 通知等機制。Scheduler 是排程來源,WakeupWatcher 是執行機構,
職責分離。

**寫 wakeup file 的欄位對應**(`WakeupPayloadSchema` 見 `src/wakeup/types.ts`):

| WakeupPayload 欄位 | 來源 |
|---|---|
| `channel_id` | schedules/crons row 的 `channel_id` |
| `prompt` | schedules/crons row 的 `prompt` |
| `source` | `"schedule_wakeup"` 或 `"cron_fire"` (lowercase regex) |
| `metadata.schedule_id` | schedules/crons row 的 `id` (dedupe & traceability) |
| `created_at` | `new Date(now).toISOString()` (**ISO 8601 string,非 ms**) |
| `ttl_seconds` | **固定 60**(這是 wakeup file 本身的 TTL,不是 schedule 的 TTL) |

⚠️ 兩種 TTL 不同語意,不能混淆:
- `schedules.ttl_seconds`:排程「有效」的時窗(默認 3600s)。過了就 miss。
- WakeupPayload `ttl_seconds`:wakeup file 從落地到被 watcher 處理的容忍時間
  (60s 已極寬)。過了 `WakeupWatcher` 丟棄。

Scheduler 在 tick 時已篩過第一種 TTL 才寫 file,第二種 TTL 是最後一道防線。

### DB Schema

兩張新 table 加入現有 `data.db`。migration 走現有 `CREATE TABLE IF NOT EXISTS`
pattern,老 users 升級自動建表。

#### `schedules` (一次性)

```sql
CREATE TABLE IF NOT EXISTS schedules (
  id           TEXT PRIMARY KEY,          -- "sch_xxxxxxxx"
  channel_id   TEXT NOT NULL,             -- Discord channel
  fire_at      INTEGER NOT NULL,          -- ms since epoch (UTC)
  prompt       TEXT NOT NULL,
  reason       TEXT,                      -- Claude 提供,for /schedules list 顯示
  source       TEXT NOT NULL,             -- 目前一律 "ScheduleWakeup"
  ttl_seconds  INTEGER NOT NULL DEFAULT 3600,
  created_at   INTEGER NOT NULL,
  FOREIGN KEY (channel_id) REFERENCES projects(channel_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_schedules_fire_at ON schedules(fire_at);
CREATE INDEX IF NOT EXISTS idx_schedules_channel ON schedules(channel_id);
```

- ms epoch(非 ISO string):tick 比較 & 排序更快、無 timezone bug
- `ttl_seconds` 可配置(不 hard-code 3600)—— 未來 Claude 若想指定不同 TTL 有欄位承接
- FK CASCADE:頻道 unregister 時排程一併消,無孤兒

#### `crons` (重複)

```sql
CREATE TABLE IF NOT EXISTS crons (
  id           TEXT PRIMARY KEY,          -- "cron_xxxxxxxx"
  channel_id   TEXT NOT NULL,
  cron_expr    TEXT NOT NULL,             -- "0 9 * * *"
  prompt       TEXT NOT NULL,
  name         TEXT,                      -- 人類可讀名稱
  next_fire    INTEGER NOT NULL,          -- ms since epoch, pre-computed
  last_fire    INTEGER,                   -- ms since epoch, 觀察用
  created_at   INTEGER NOT NULL,
  FOREIGN KEY (channel_id) REFERENCES projects(channel_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_crons_next_fire ON crons(next_fire);
CREATE INDEX IF NOT EXISTS idx_crons_channel ON crons(channel_id);
```

- `next_fire` pre-compute 是效能關鍵:tick `WHERE next_fire <= now`,不用每輪
  parse cron expression
- `last_fire` 純觀察用,不參與邏輯,可 NULL

#### 資料量預估

Discord bot 個人用,穩態量小。假設高強度 Claude 一天 100 個 wakeup,一個月
3000 row。fire 完 DELETE,穩態 < 100 row。30s tick 掃 index 過的 int 欄位
μs 級,可忽略。

### Slash Command `/schedules`

新增第 11 個 slash command,放 `src/bot/commands/schedules.ts`。

**Sub-commands**:

```
/schedules list            列出當前 channel 的所有排程 (schedules + crons)
/schedules cancel <id>     取消(schedule 或 cron 皆可)
/schedules info <id>       看單一排程細節
```

**故意不做**:
- ✗ `/schedules snooze` — 取消再讓 Claude 重排效果相同,YAGNI
- ✗ `/schedules create` — 這是 Claude 的權限,人類不從 UI 建
- ✗ `/schedules pause` — YAGNI

**`/schedules list` 輸出範例**:

```
📅 目前排程 (channel: #ai-eden-service)

⏱️ 一次性 (3)
├─ sch_a1b2  在 2m 12s 後   Check R-018 Run 1 attempt 5...
├─ sch_c3d4  在 12m 後       Poll autoplay run 2 status
└─ sch_e5f6  在 45m 後       Verify PR #137 CI green
    ⚠️ 剩 15m 到 TTL

🔁 Cron (1)
└─ cron_9x8  每天 09:00      早會 PR 摘要
    上次:昨天 09:00 · 下次:2h 34m 後
```

- 只列當前 channel(隔離,不會看到別頻道)
- 相對時間顯示,絕對時間需要時用 `/schedules info`
- TTL 警告只在剩 < 20% 時顯示

**`/schedules cancel` 互動**:StringSelectMenu → 確認 button → DELETE → `✅ 已取消`。

**授權**:沿用 `guard.ts` 的 `ALLOWED_USER_IDS` 白名單。取消 = 阻止 Claude 自主
行為,必須是註冊使用者。

### Error handling & edge cases

#### Hook 攔截失敗
Hook 內 try/catch,catch 後回 `permissionDecision: "deny"` + reason。Claude
收到 error tool_result 自己決策要不要 retry。錯誤 log 到 stderr。**絕對不能
silent-succeed**,否則 Claude 以為排了,實際沒排。

#### Scheduler tick throw
每 row 用獨立 try/catch 包(見上面 pseudocode),一 row 死不影響其他。tick
外層再包一層,絕不讓 setInterval callback 拋出崩掉 daemon。錯誤 log rate-limit
(同一 row 每 tick log 一次會刷屏)。

#### Bot 重啟時剛好過 fire_at
`start()` 時**立即做一次 tick**(不等 30s)。已過 fire_at 的 row 走同樣 TTL 判
斷:未過期正常 fire、過期 miss 通知。若同時多個 fire → 依序寫 wakeup file,
`WakeupWatcher` 依 active/idle 邏輯處理。同時 miss 5 條 → 合併成一則:

```
⚠️ Bot 停機期間 miss 了 5 個排程:
├─ sch_a1b2 (排定於 2h 前)  Check R-018 Run 1 attempt 5...
├─ sch_c3d4 (排定於 1h 40m 前)  Poll autoplay run 2 status
└─ ... (共 5 條)
```

#### Cron next_fire 落到過去
不補跑歷史。`next_fire = cronParser.parseExpression(expr, {currentDate: now}).next()`
直接推到未來下一 slot。發 `⏰ Cron cron_xxx 期間 miss 了 3 次,已跳到下次:tomorrow 09:00`。

#### Claude 排太多
Hook 檢查同 channel `schedules + crons < 50`,超過 deny + reason。軟上限,理性
Claude 不會撞。

#### WAKEUP_DIR 磁碟滿
Scheduler catch,不刪 DB row(下輪 tick 再試)。連續失敗只 log,不加 attempts
欄位(YAGNI)。

#### Discord API 掛掉
catch、log、不 retry。下次 `/schedules list` 使用者看得到狀態。Scheduler tick
不因 Discord 掛而停。

#### 頻道 unregister 後排程還在
DB FK CASCADE 已處理。Scheduler 額外防禦:tick 時若 channel 不在 `projects`
table,skip + delete。Defense-in-depth,便宜。

#### Claude 用 CronDelete 刪不存在的 id
回 `"Cron cron_xxx not found in this channel"`(non-error no-op),不引 retry loop。

#### Session resume 失敗(SDK session_id 過期)
復用 `session-manager.ts:642-657` 現有 retry-without-resume 邏輯,不改。

### 靜默觸發策略

排程 fire 時**不推額外通知**。使用者在 ai-eden-service session log 看過的 UX
就是最終 UX:Claude 直接開新 turn、streaming 出訊息、result embed 落地 —— 跟
使用者手動打字沒差別。理由:

- 使用者 Discord channel 已設 All Messages notification,任何新訊息都推播
- 「排程即將觸發」的預告訊息會讓 channel 噪音變兩倍(預告 + 實際結果)
- Claude 自己的回應本來就交代了脈絡(reason 已存在 DB,若需要 Claude 可查)

## Testing

### 單元測試

專案用 vitest,測試檔 co-locate 在 module 旁。

| 檔案 | 測試重點 |
|---|---|
| `src/hooks/pre-tool-use.test.ts` | 五個 tool 攔截行為:輸入 → DB 效果 + 假 result 字串 |
| `src/scheduler/tick.test.ts` | fire_at ≤ now 觸發、TTL 過期 miss、cron next_fire 更新、error 隔離 |
| `src/db/schedules.test.ts` | CRUD + CASCADE + index 生效 |
| `src/db/crons.test.ts` | CRUD + cron_expr 儲存 |
| `src/cron/parser.test.ts` | invalid expr throw、`next()` 計算正確 |
| `src/bot/commands/schedules.test.ts` | list / cancel / info 的 embed 內容格式 |

**風格**:純函數優先。`tick()` 抽成 `tick(clock, db, wakeupWriter)` 三依賴注入,
測試 mock clock 到任意時間點。

### 整合測試

`test/integration/schedule-end-to-end.test.ts`:
1. Mock SDK query 吐一則假 `ScheduleWakeup` tool_use
2. Hook 接住 → 寫 schedules table
3. 快轉 clock,`scheduler.tick()`
4. 驗證 wakeup file 有寫入正確 payload
5. 讓真的 `WakeupWatcher` 讀取,驗證呼叫 `wakeUp` 一次

不 mock:DB(用 `:memory:` sqlite)、檔案系統(用 tmp dir)、WakeupWatcher(整
條 pipeline 一起測)。

### 手動 smoke test(PR merge 前必做)

自動測試無法完全覆蓋 SDK / Claude 真實行為。

1. **短延遲**:ai-eden-service channel 叫 Claude `ScheduleWakeup(60)` → 確認
   1 分鐘後 session 真的 resume
2. **Cron**:`CronCreate("*/2 * * * *", ...)` → 觀察 3 個週期
3. **重啟**:排 3 分鐘 wakeup → 立刻 `pm2 restart bot` → 確認 restart 後仍在
   3 分鐘後 fire
4. **TTL**:排 60s wakeup → 睡眠電腦 2 小時 → 喚醒 → 確認收到 miss 通知,session
   未被 wake
5. **`/schedules`**:list / cancel / info 各測一次
6. **PushNotification**:讓 Claude 呼叫 → 確認訊息落地(無 @mention)

### 不測

- Claude 是否會用這些工具 — 非 bot 責任
- `cron-parser` 套件正確性 — 信任套件
- Discord 手機 push 是否觸發 — 超出可測範圍(使用者已確認群組通知會跳)

## Rollout

單一 PR,一次到位。所有變更向後相容:
- 新 DB tables 用 `IF NOT EXISTS`,老 users 升級自動建表
- Hook 註冊在 `query()` options,不改任何現有 tool 的行為
- Scheduler daemon opt-in from bot startup,關掉 `setInterval` 就退化成無此功能
- Slash command 註冊到 guild 時新增,不影響現有 10 個 commands

## Open questions(implementation 時解)

1. **PreToolUse hook「deny + 正面 reason」的 Claude 反應** — 主要策略假設
   Claude 收到 `permissionDecision: "deny"` + `reason: "Next wakeup scheduled..."`
   時會當成 informational,不會 retry loop。實測時第一個 PoC 就驗證這點;若
   失敗走「Hook 通用機制」節列出的退路方案 A / B。
2. **`CronCreate` 的 tool input schema** — 目前是推測(`{schedule, prompt, name}`),
   實測時把第一個 CronCreate 呼叫的 tool_use payload log 下來以確認欄位名。
3. **`PushNotification` 的 priority 欄位** — 是否有 low/normal/high 差異;若有,
   可用來決定要不要伴隨聲音 embed。目前設計忽略,priority=high 也一樣發純
   `channel.send`。

以上都是 implementation-time discoveries,不影響架構。
