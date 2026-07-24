# Tray Claude Auto-Updater — Manual Smoke Tests

Run these before merging any change to `menubar/ClaudeUpdater.swift` or the `updateCli` / `updateSdk` / `checkClaudeUpdatesIfDue` code in `menubar/ClaudeBotMenu.swift`.

**Prerequisites:**
- Bot registered to a Discord channel (so SDK restart flow can be verified)
- Global `claude` CLI installed via `install.sh` (or `npm install -g @anthropic-ai/claude-code`)
- Fresh state (delete `~/.claudecode-discord/claude-update-state.json` if present)

## 1. State machine

- [ ] **1a. First run bootstraps state**
  - Delete `~/.claudecode-discord/claude-update-state.json`
  - Kill and relaunch tray (`pkill -f ClaudeBotMenu; ./menubar/ClaudeBotMenu &`)
  - After ~10 seconds (boot-time check runs), `cat ~/.claudecode-discord/claude-update-state.json` — should exist with `schema_version: 1`, `cli.current` populated, `sdk.current` populated.

- [ ] **1b. Debounce (< 20h)**
  - With state present and recent `last_check`, wait for the 5h timer OR click "Check now" — Check now should still run (force=true).
  - Verify `last_check` was updated to now.
  - Without Check now, no automatic run should happen within 20 hours.

- [ ] **1c. Stale (> 20h)**
  - Manually edit `state.json` `last_check` to 25 hours ago (ISO 8601 UTC).
  - Wait for 5h timer OR click "Check now".
  - `last_check` updates to now.

## 2. CLI update

- [ ] **2a. Downgrade + auto-update**
  - `npm install -g @anthropic-ai/claude-code@2.1.180` (any version older than latest).
  - `claude --version` reports 2.1.180.
  - Tray menu → "Check now".
  - macOS notification "🟢 Claude Updated CLI: 2.1.180 → <latest>" appears.
  - `claude --version` reports new version.

- [ ] **2b. Same version → skip**
  - Click "Check now" again immediately.
  - No notification.
  - `state.history` has no new entry.

## 3. SDK update (requires running bot)

- [ ] **3a. Downgrade + auto-update**
  - `cd /path/to/claudecode-discord && npm install @anthropic-ai/claude-agent-sdk@0.2.130 --save`
  - Restart bot via tray "Start".
  - `cat node_modules/@anthropic-ai/claude-agent-sdk/package.json | grep version` shows 0.2.130.
  - Tray menu → "Check now".
  - Wait ~30-60 seconds for `npm install` + verify + build.
  - Notification "🟢 Claude SDK Updated SDK: 0.2.130 → <latest> Bot restarted." appears.
  - `cat node_modules/@anthropic-ai/claude-agent-sdk/package.json` shows new version.
  - Snapshot preserved at `~/.claudecode-discord/sdk-backups/<iso>-0.2.130/`.

## 4. Rollback (simulated failure)

- [ ] **4a. Fake verify failure**
  - Temporarily break tsc: `mv node_modules/typescript/bin/tsc node_modules/typescript/bin/tsc.bak`.
  - `npm install @anthropic-ai/claude-agent-sdk@0.2.130 --save` to establish a downgrade target.
  - Tray "Check now".
  - Notification "🔴 SDK Update Failed" appears.
  - `state.sdk.blocklist` has entry with `attempts: 1`.
  - Snapshot dir renamed to `<iso>-0.2.130-FAILED/`.
  - `failure-log.txt` inside contains `failed_step: tsc`.
  - `node_modules/@anthropic-ai/claude-agent-sdk/package.json` still 0.2.130 (rolled back).
  - Restore `tsc.bak` → `tsc`.

## 5. Blocklist reaches threshold

- [ ] **5a. 3-strike block**
  - With verify still broken (keep `tsc` renamed), click "Check now" two more times.
  - After the 3rd failure, notification "⚠️ SDK Update Blocked SDK X.Y.Z blocked after 3 failed attempts".
  - Click "Check now" a 4th time — silent, no notification (blocklisted).
  - `state.sdk.blocklist[0].attempts == 3`.

## 6. Network failure

- [ ] **6a. Offline**
  - Turn off WiFi / disconnect network.
  - Click "Check now".
  - No crash, no notification.
  - `state.check_errors[]` has new entry with `reason: "npm view failed (network?)"`.
  - `last_check` NOT updated (retries next timer).
  - Restore network, click "Check now" — normal flow resumes.

## 7. Tray restart during update

- [ ] **7a. Interrupt SDK install**
  - Downgrade SDK: `npm install @anthropic-ai/claude-agent-sdk@0.2.130 --save`.
  - Click "Check now".
  - Within 5 seconds (while `npm install` is running), quit tray.
  - Relaunch tray.
  - No orphaned non-FAILED snapshot dirs (aside from any from step 4).
  - Next "Check now" completes normally.

---

If ANY step fails, do NOT merge — investigate first. Update this doc if the flow changes.
