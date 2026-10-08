# Tray Claude Auto-Update for claudecode-discord

**日期**:2026-07-13
**作者**:brainstorm with Claude
**狀態**:approved, ready for implementation plan

---

## Problem

Bot 依賴兩個獨立的 Claude npm 套件,但兩者都會沉默地過期:

| 位置 | npm 套件 | 用途 |
|---|---|---|
| Global `/usr/local/bin/claude` | `@anthropic-ai/claude-code` | 使用者 `claude login`、在 terminal 用 claude 的入口 |
| SDK 內建 `node_modules/@a-a/claude-agent-sdk-darwin-arm64/claude` | `@anthropic-ai/claude-agent-sdk` | Bot 內部生 Claude session 的核心 |

現況觀察(2026-07-13):
- Global CLI:2.1.191(不新不舊)
- SDK bundle:2.1.141(五月版本,已過期兩個月)
- SDK npm latest:0.3.212(**跨主版本** vs installed 0.2.141)

Bot 沒有任何機制主動檢查這些套件。使用者要手動:
- `npm install -g @a-a/claude-code@latest`(每次都得記得)
- `npm install @a-a/claude-agent-sdk@latest` + `npm run build` + 重啟 bot

**痛點:**
- 使用者 A 幾乎不會做,結果 bot 跑著半年前的 SDK
- 使用者 B 手動升級但 SDK 主版本跳 breaking → bot 掛掉、debug 好久才發現
- 沒有 rollback 機制,壞了就是壞了

## Root cause

Bot 開發時假設「依賴由使用者管理」。這個假設對 open-source 個人專案不成立 —— 使用者沒動力/沒時間管理依賴。而 SDK 是 0.x 版,主版本跳頻繁,自動升級也不安全。

需要一個**tray-level 常駐檢查器**:每天檢查 → 有新版就裝 → 裝完 verify → 壞了 rollback。全流程無使用者介入(除非壞掉才通知)。

## Solution

在既有 macOS tray app(`menubar/ClaudeBotMenu.swift`)加一個 `checkClaudeUpdates` 管線,piggyback 現有 5-hour timer + 20h debounce 實現每日檢查:

- **CLI(@a-a/claude-code)**:低風險,直接 `npm install -g @latest`。裝完跑 `claude --version` verify。失敗 3 次進 blocklist,rollback 到已知的前一版。
- **SDK(@a-a/claude-agent-sdk)**:高風險,snapshot `package.json` + `package-lock.json` → 停 bot → `npm install ...@latest` → 跑 `tsc --noEmit` + `npm run build` + 執行 SDK-bundled `claude --version` + (可選)測試 → 全綠才重啟 bot。任一步驟壞掉 → 還原 snapshot + `npm install` → 重啟 bot。
- **狀態檔**:`~/.claudecode-discord/claude-update-state.json` 存 last_check、current versions、blocklist、history。
- **通知**:macOS native notification(osascript display notification)。**不發 Discord** —— 使用者手邊 mac 就會看到。
- **手動觸發**:tray 選單新增 "Claude versions" section 顯示當前版本 + Check now 選項。

## Design

### Architecture overview

```
┌─ ClaudeBotMenu.swift (macOS tray) ─────────────────────────────────┐
│                                                                     │
│  Timer (existing, 5h) ──┬── checkForUpdates()   [bot code, unchanged]│
│                          │                                          │
│                          └── checkClaudeUpdatesIfDue() ★ NEW         │
│                              │                                       │
│                              ├─ debounce: skip if last < 20h ago     │
│                              │                                       │
│                              ├─ 1. updateCli()  (@a-a/claude-code)  │
│                              │    ├─ query npm view → latest         │
│                              │    ├─ compare `claude --version`      │
│                              │    ├─ npm install -g @latest          │
│                              │    ├─ verify: claude --version works? │
│                              │    ├─ fail → install @<prev>          │
│                              │    └─ notify (native)                 │
│                              │                                       │
│                              └─ 2. updateSdk()  (@a-a/claude-agent-sdk)│
│                                   ├─ query npm view → latest        │
│                                   ├─ compare package.json           │
│                                   ├─ snapshot package.json+lock     │
│                                   ├─ stopBot() if running           │
│                                   ├─ npm install ...@latest --save  │
│                                   ├─ verify: tsc + build + claude   │
│                                   │           --version + tests?    │
│                                   ├─ fail → restore snapshot + npm i│
│                                   ├─ success → startBot() (if was)  │
│                                   └─ notify (native)                 │
│                                                                     │
│  State file: ~/.claudecode-discord/claude-update-state.json        │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

三大職責分離:
- **`checkClaudeUpdatesIfDue`** — 排程邏輯 + debounce + lock,不管實際升級
- **`updateCli` / `updateSdk`** — 兩條獨立管線,一個壞不影響另一個
- **State file I/O + notifications** — 純副作用層,測試時可 mock

### CLI update flow (@anthropic-ai/claude-code)

```
1. currentVersion  = parseClaudeVersion(runShell("claude --version 2>/dev/null"))
                     ↓ "2.1.191 (Claude Code)" → "2.1.191"
2. latestVersion   = runShell("npm view @anthropic-ai/claude-code version")
                     ↓ trimmed, e.g. "2.1.191"
3. if current == latest → skip, done
4. if latest in state.cli.blocklist → skip + log "blocked", done
5. previousVersion = current  (in-memory, for rollback)
6. runShell("npm install -g @anthropic-ai/claude-code@\(latest) 2>&1")
7. verify: parseClaudeVersion(runShell("claude --version"))
    → must be non-nil AND contain latest
8. if verify OK:
     append history { kind:"cli", from:previous, to:latest, outcome:"success" }
     notify(macOS): "🟢 Claude CLI Updated: previous → latest"
     state.cli.current = latest
9. if verify FAIL:
     runShell("npm install -g @anthropic-ai/claude-code@\(previous) 2>&1")
     upsert blocklist entry { version: latest, attempts++, last_failed_at, reason, log_snippet }
     if attempts == 3 → notify blocklist entry (once), afterwards silent
     append history { outcome:"failed", failed_at_step:"verify" }
     notify(macOS): "🔴 CLI update to X failed, rolled back to Y"
```

**Verify 只做「`claude --version` 能跑且包含 latest 字串」**。理由:
- 主要抓「安裝完全失敗」+「installed 版本不是要的版本」
- 這個工具沒有其他明顯的功能可以在 CI 秒級驗證
- 深度測試(login flow)超出範圍

**不需要 rollback snapshot 檔**:`npm install -g X@Y` 是原子,rollback 只需要 previous 版本號 (in-memory 記錄)。CLI 是全域工具,bot 不用它 —— 升級 / rollback 過程 bot 完全無感。

### SDK update flow (@anthropic-ai/claude-agent-sdk)

```
 1. currentVersion  = read node_modules/@a-a/claude-agent-sdk/package.json.version
 2. latestVersion   = runShell("npm view @anthropic-ai/claude-agent-sdk version")
 3. if current == latest → skip, done
 4. if latest in state.sdk.blocklist → skip + log, done

 5. snapshotDir = ~/.claudecode-discord/sdk-backups/\(iso)-\(current)/
    ├─ cp package.json     → snapshotDir/
    └─ cp package-lock.json → snapshotDir/
    (若 snapshot fail → abort update,notify,不改 state)

 6. wasRunning = isRunning()
    if wasRunning: stopBot()

 7. runShell("cd botDir && npm install @a-a/claude-agent-sdk@\(latest) --save 2>&1")
    → capture stdout+stderr, save to snapshotDir/install.log

 8. Verify sequence — 任一 step fail 就直接 rollback:
    (a) install exit code == 0
    (b) new node_modules/@a-a/claude-agent-sdk/package.json.version == latest
    (c) runShell("cd botDir && npx tsc --noEmit 2>&1") exit code == 0
    (d) runShell("cd botDir && npm run build 2>&1") exit code == 0
    (e) runShell("cd botDir && node_modules/@a-a/claude-agent-sdk-darwin-arm64/claude --version")
        must return non-empty version-containing string
    (f) (optional) if state.verify_run_tests == true:
        runShell("cd botDir && npm test -- --run 2>&1") exit code == 0

 9. If ALL verify pass:
      if wasRunning: startBot()   // 用新 SDK 重啟
      append history { kind:"sdk", from:previous, to:latest, outcome:"success" }
      notify(macOS): "🟢 Claude SDK Updated: previous → latest, bot restarted"
      state.sdk.current = latest
      rotate snapshotDir (see 3.2)

10. If ANY verify fail:
      // Rollback
      cp snapshotDir/package.json       → botDir/package.json
      cp snapshotDir/package-lock.json  → botDir/package-lock.json
      runShell("cd botDir && npm install 2>&1")     // 恢復 node_modules
      runShell("cd botDir && npm run build 2>&1")   // 恢復 dist
      if wasRunning: startBot()   // 舊 SDK 重啟
      upsert blocklist entry (attempts++, reason)
      append history { outcome:"failed", failed_at_step:"tsc"|"build"|... }
      notify(macOS): "🔴 SDK update to X failed at step Y, rolled back to Z"
      mv snapshotDir to snapshotDir-FAILED (7 天後清)
```

**Snapshot dir 管理**:

```
~/.claudecode-discord/sdk-backups/
├─ 2026-07-13T08-42-04Z-0.2.141/           成功升前的 snapshot(rotate to keep last 3)
│  ├─ package.json
│  ├─ package-lock.json
│  └─ install.log
└─ 2026-07-14T08-42-11Z-0.2.141-FAILED/    失敗殘骸(7 天後清)
   ├─ package.json
   ├─ package-lock.json
   ├─ install.log
   └─ failure-log.txt  (verify step 各步驟 stderr)
```

Rotation 在每次成功升級後跑:掃 `sdk-backups/`,保留最新 3 個 non-FAILED、清 > 7 天的 FAILED。

**Verify 為什麼跑 tsc + build 兩者?**
- `tsc --noEmit`:抓 SDK type export 變動(例如 `query()` 的參數簽名改了)。秒級。
- `npm run build`(tsup):抓 module resolution + 打包管線問題。~10s。
- 兩者組合覆蓋「API breaking」+「打包破口」。

**verify_run_tests 預設 `true`**:全 test suite ~2 秒(430 tests),值得。使用者要關手改 state.json。

**bot 重啟只在原本 running 時觸發**:尊重使用者手動停 bot 的意圖。`wasRunning` 在 step 6 錨定。

### State file: `~/.claudecode-discord/claude-update-state.json`

```json
{
  "schema_version": 1,
  "last_check": "2026-07-13T08:42:04Z",
  "verify_run_tests": true,
  "cli": {
    "current": "2.1.191",
    "blocklist": []
  },
  "sdk": {
    "current": "0.2.141",
    "blocklist": [
      {
        "version": "0.3.212",
        "attempts": 3,
        "last_failed_at": "2026-07-13T09:00:00Z",
        "reason": "tsc --noEmit failed",
        "log_snippet": "src/... error TS2322: ..."
      }
    ]
  },
  "history": [
    { "kind": "cli", "from": "2.1.190", "to": "2.1.191", "at": "2026-07-13T08:42:04Z", "outcome": "success" },
    { "kind": "sdk", "from": "0.2.141", "to": "0.3.212", "at": "2026-07-13T09:00:00Z", "outcome": "failed", "failed_at_step": "tsc" }
  ],
  "check_errors": []
}
```

**設計說明**:
- `schema_version: 1` — 未來擴充判斷相容性
- `verify_run_tests` — 預設 `true`;可手動關
- `current` — 每次 check 實測寫入,不信任 cache
- `history` — 保 30 筆,超過 shift 掉最舊
- `check_errors` — 保 5 筆,存網路失敗等 non-actionable 錯
- `log_snippet` — 失敗 stderr 最後 500 字,方便診斷

**I/O 規則**:
- Swift `JSONSerialization` 讀寫
- **原子寫入**:寫 `.tmp` → `rename`
- **格式壞掉時** → backup 為 `state.json.corrupted-<ts>` + 用預設值重建

### Notifications

用既有 `runShell("osascript -e 'display notification ...'")` pattern。

| 情境 | 標題 | 內容 | Sound |
|---|---|---|---|
| CLI 成功 | 🟢 Claude Updated | `CLI: 2.1.190 → 2.1.191` | Ping |
| SDK 成功 | 🟢 Claude SDK Updated | `SDK: 0.2.141 → 0.2.999\nBot restarted with new SDK.` | Ping |
| CLI 失敗 rollback | 🔴 Claude Update Failed | `CLI 2.2.0 → 2.1.191 (rolled back)\nReason: verify failed` | Sosumi |
| SDK 失敗 rollback | 🔴 Claude Update Failed | `SDK 0.3.212 → 0.2.141 (rolled back)\nReason: tsc --noEmit failed\nSee state.json` | Sosumi |
| Blocklist 進入(一次) | ⚠️ Update Blocked | `SDK 0.3.212 blocked after 3 failed attempts` | Ping |
| Blocklist 每天 skip | (無通知) | | |
| Rollback 本身失敗 | 🔴🔴 Recovery Failed | `Update AND rollback failed — manual intervention required` | Sosumi |

**Discord 不發**。使用者已在 macOS,原生通知足夠;避免 Discord 頻道歷史噪音。

### Cadence + tray menu integration

**Timer 整合**:

```swift
// existing block at ClaudeBotMenu.swift:134-137
Timer.scheduledTimer(withTimeInterval: 18000, repeats: true) { [weak self] _ in
  self?.checkForUpdates()          // bot code, existing
  self?.checkClaudeUpdatesIfDue()  // ★ new
}

// Boot: fire once immediately
DispatchQueue.global(qos: .background).async { [weak self] in
  self?.checkClaudeUpdatesIfDue()
}
```

**Debounce**:20 hours。理由:5h timer × 4 = 20h 剛好覆蓋到下次 tick;取 24h 會偶爾錯過。

**Concurrent-invocation lock**:

```swift
private var claudeUpdateInProgress = false

func checkClaudeUpdatesIfDue(force: Bool = false) {
  if claudeUpdateInProgress { return }
  claudeUpdateInProgress = true
  defer { claudeUpdateInProgress = false }
  // ... check + update logic
}
```

Swift 單 process 不用 lock 檔案。

**Tray menu 新增 section**(接在既有 "Update Available..." 之後):

```
──────────────
Claude versions
├─ CLI:  2.1.191 ✓
├─ SDK:  0.2.141 ✓
└─ Check now
```

- 版本後 icon:✓ 綠(已是 latest)、● 黃(有更新)、✗ 紅(blocklist)
- "Check now" → `checkClaudeUpdatesIfDue(force: true)` 繞過 20h debounce

### Error handling & edge cases

#### 網路失敗(npm view 拋錯 / timeout)
- `runShell("npm view ...")` timeout 30s
- 空字串 / 錯誤輸出 → check 失敗
- **不寫** `last_check`(下次 tick 會再試)
- **不通知**(離線通知會煩)
- 記到 `state.check_errors[]`(rolling 5 筆)

#### `claude` 全域指令消失(user npm uninstall 掉)
- CLI 流程判定「當前 = 未安裝」→ 首次安裝
- 首次安裝失敗 → 一般失敗流程(notify + blocklist)
- 不會誤刪 — tray 不會主動 `npm uninstall -g`

#### SDK 內建 claude binary 損壞
- Verify step 8(e) fail
- Rollback `npm install` 會重下載完整 SDK → 修復損壞的 binary
- 若 rollback 仍失敗 → notify + 詳細 log

#### 磁碟滿 / 沒寫入權限
- Snapshot 寫入失敗 → abort SDK 更新
- notify: `🔴 Cannot snapshot, skipping update — check disk space`
- 不改 state.json,下次會再試
- CLI 不受影響(不需 snapshot)

#### npm registry 說 latest = X 但 install X 網路中斷
- `npm install` exit code ≠ 0 → verify step 8(a) fail → rollback
- attempts += 1,3 次才進 blocklist —— 給網路波動空間

#### Rollback 本身失敗(最壞情況)
- notify(**loud**):`🔴🔴 Update AND rollback failed — manual intervention required`
- `outcome: "rollback_failed"` 進 state.json.history
- **不啟動 bot**(即使 wasRunning),避免帶壞環境跑
- 使用者手動:`git checkout package.json && npm install && npm run build && ClaudeBotMenu → Start`

#### npm registry 版本回退(latest 反而變舊)
- current > latest → skip,不做事
- 只往前不往後

#### Blocklist 越積越長
- Blocklist 保 30 筆,shift 最舊
- 舊版本不會突然變回 latest,shift 無害

#### User 手動改了 package.json
- Tray 尊重使用者當前版本
- `state.sdk.current` 更新為實測值
- latest > 實測 → 正常嘗試 update

#### Tray 自己在檢查中被 quit
- `state.json` 用原子寫入,不會半完成
- Snapshot 檔沒清乾淨 OK,下次啟動時掃 backup dir 清 > 7 天
- 不需要 crash recovery

#### Bot 在 stopBot() 卡住
- 復用既有 `stopBot()`(SIGTERM + SIGKILL fallback)
- 若真的殺不掉 → notify + 不 install(避免起兩個 bot instance)

### 靜默觸發策略

排程 fire 時**不推額外通知**。使用者已設 macOS notification 為主要 channel,任何新訊息都會 push。加預告訊息會兩倍 channel 噪音。

## Testing

### Pure logic → 抽出可測

新增 `menubar/ClaudeUpdater.swift` 存純函數:

```swift
enum ClaudeUpdater {
  static func parseClaudeVersion(_ output: String) -> String?
  static func compareSemver(_ a: String, _ b: String) -> ComparisonResult
  static func isBlocklisted(_ version: String, blocklist: [BlocklistEntry]) -> Bool
  static func shouldCheck(lastCheck: Date?, now: Date, debounceHours: Int) -> Bool
  static func nextRotatedHistory(_ history: [Entry], newEntry: Entry, cap: Int) -> [Entry]
  static func loadState(from data: Data) -> State
  static func serializeState(_ state: State) -> Data
}
```

副作用部分留在 `ClaudeBotMenu.swift` 的 method 裡,**不 unit-test**,只手動 smoke。

### 測試 infrastructure:引入 SPM

新增 `menubar/Package.swift`:

```swift
// swift-tools-version:5.5
import PackageDescription

let package = Package(
  name: "ClaudeBotMenu",
  targets: [
    .executableTarget(
      name: "ClaudeBotMenu",
      path: ".",
      exclude: ["Package.swift", "Tests"],
      sources: ["ClaudeBotMenu.swift", "ClaudeUpdater.swift"]
    ),
    .testTarget(
      name: "ClaudeUpdaterTests",
      dependencies: ["ClaudeBotMenu"],
      path: "Tests",
      sources: ["ClaudeUpdaterTests.swift"]
    )
  ]
)
```

**含意**:
- `swift test` 可跑,標準 SPM 生態
- `install.sh` 現有 `swiftc -o ClaudeBotMenu ClaudeBotMenu.swift` 需改為 `cd menubar && swift build -c release`,binary 位置改為 `.build/release/ClaudeBotMenu`
- Tray 自我更新 flow(現在 `swiftc` line ~355)也要改用 `swift build`

**這是必要的一次性投資** —— 未來 tray 只會長大,不能永遠一個 file 沒 test。

### 具體 test cases

`menubar/Tests/ClaudeUpdaterTests.swift`:

| 測試 | 期望 |
|---|---|
| `test_parseClaudeVersion_valid` | `"2.1.191 (Claude Code)\n"` → `"2.1.191"` |
| `test_parseClaudeVersion_empty` | `""` → `nil` |
| `test_parseClaudeVersion_garbage` | `"claude: command not found"` → `nil` |
| `test_compareSemver_less` | `("0.2.141", "0.2.999")` → `.orderedAscending` |
| `test_compareSemver_greater` | `("0.3.0", "0.2.999")` → `.orderedDescending` |
| `test_compareSemver_equal` | `("1.0.0", "1.0.0")` → `.orderedSame` |
| `test_compareSemver_major_jump` | `("0.2.141", "0.3.0")` → `.orderedAscending` |
| `test_isBlocklisted_in` | version in list → `true` |
| `test_isBlocklisted_out` | version not in list → `false` |
| `test_shouldCheck_no_previous` | `lastCheck = nil` → `true` |
| `test_shouldCheck_recent` | 5h ago + debounce 20h → `false` |
| `test_shouldCheck_old` | 25h ago + debounce 20h → `true` |
| `test_nextRotatedHistory_under_cap` | 20 entries + 1 new + cap 30 → 21 entries |
| `test_nextRotatedHistory_over_cap` | 30 entries + 1 new + cap 30 → 30 entries (oldest dropped) |
| `test_loadState_valid_v1` | valid JSON → 正確 struct |
| `test_loadState_corrupt` | invalid JSON → default state,不 crash |
| `test_loadState_schema_v_mismatch` | `schema_version: 99` → default,不 crash |
| `test_serializeState_roundtrip` | encode → decode → deep equal |

**目標**:~15-18 個 test cases。純函數優先。

### 不寫整合測試

要真的 `npm install ...@latest` 汙染測試環境;要真的 `stopBot / startBot` 需要跑中 bot。ROI 差 —— 手動 smoke test 提供這層信心。

### 手動 smoke test(PR merge 前必做)

新增 `menubar/TESTING-updater.md`:

1. **State machine**
   - [ ] 首次啟動(state.json 不存在)→ 執行完後 state.json 產生
   - [ ] state.json 存在且 last_check 為 5h 前 → 不觸發(debounce 生效)
   - [ ] state.json 存在且 last_check 為 25h 前 → 觸發

2. **CLI update**
   - [ ] 手動降 CLI:`npm install -g @a-a/claude-code@2.1.180`
   - [ ] 托盤 "Check now" → 看到 `🟢 Claude CLI updated: 2.1.180 → 2.1.191`
   - [ ] `claude --version` 回報新版

3. **SDK update(需 bot running)**
   - [ ] 手動降 SDK:`cd bot && npm install @a-a/claude-agent-sdk@0.2.130`
   - [ ] 托盤 "Check now" → 看到 `🟢 Claude SDK updated...` + bot 重啟
   - [ ] node_modules 版本 = 新版

4. **Rollback(強制 verify fail)**
   - [ ] 暫時把 tsc 換成 `exit 1` wrapper(mock verify fail)
   - [ ] 觸發 update → `🔴 Update failed` + snapshot dir 保留 + 舊版本恢復

5. **Blocklist**
   - [ ] 手動改 state.json:cli.blocklist 加當前 latest 版本
   - [ ] 觸發 → skip(不通知),`last_check` 有更新

6. **網路失敗**
   - [ ] 關 WiFi → 觸發 → `state.check_errors` 有紀錄,不 crash,不 rollback

7. **Tray restart 存活**
   - [ ] 更新中(SDK install 進行時)手動 quit tray → 再開 → snapshot 殘留自動清 / 繼續正常

### CI

Tray 現在不進 CI(macOS runner 貴、二進位加 build)。加了 SPM 之後 `swift test` 可本地跑;GitHub Actions macOS runner 加 step 為 optional。

## Rollout

單一 PR 到位。所有變更向後相容:
- 新 `ClaudeUpdater.swift` 純函數,可獨立引入
- `ClaudeBotMenu.swift` 加一個 method + timer 一行呼叫,不動既有邏輯
- 新 SPM `Package.swift` —— 影響 `install.sh` 的 build command(需同步更新)、影響 tray 自我更新 flow(需同步更新)
- `state.json` 首次啟動時自動建立,無 migration
- macOS-only feature —— Linux/Windows 使用者不受影響(這些平台沒 tray)

## Open questions(implementation 時解)

1. **SPM 引入影響 `install.sh` 的相容性** — 現有 install.sh line 42-58 附近應該有 swiftc 呼叫,需改為 swift build。若這台 mac swift toolchain 版本 < 5.5,SPM 會失敗;需檢查 macOS 12+ 保底 (macOS 12 內建 swift 5.5)。
2. **Tray 自我更新 flow(ClaudeBotMenu.swift:355 附近)也要同步改用 `swift build`** — 否則使用者升級後 tray 用 swift build 產生 binary,但更新流程還在用 swiftc。這是同一個 PR 內解決。
3. **`npm view` 是否需要 auth** — 目前 npm public registry 匿名可讀,不需要。但若 `.npmrc` 有奇怪設定可能失敗,實作時測試 fallback。
