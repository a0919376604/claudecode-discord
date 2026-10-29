# Codex Discord：A 單則任務卡

使用者已選擇 vault mockup 的 A。每次 Codex 回合只維護一張原生 Discord embed，呈現任務、實際模型、最近活動、經過時間與終態；答案維持可複製的純文字訊息。Claude 現有介面維持相容。

## 介面與範圍

- `CodexTaskCard`：獨立管理狀態、有限活動紀錄、原生 embed/buttons、節流與序列化編輯。只有後端回報 plan 時才呈現步驟，沒有推測百分比、測試數或檔案數。
- `SessionManager`：每回合獨立 `runId`；註冊最新卡片、記錄後端事件、完成或失敗時更新原卡。長任務只另發一則結果連結通知。
- 按鈕：詳情為 ephemeral；停止需確認且驗證 channel + runId，先顯示停止中；中斷確認後才顯示已停止。復原會先檢查工作目錄及既有成果，再繼續，不重播已完成的寫入。
- 模型：Codex 使用獨立 `codex_model` override，`/model` 與卡片選單修改同一設定，僅於下次訊息生效。現有 Claude override 不傳給 Codex。run-plan 全域模型為另一個既有工作項目的獨立設定。
- Codex app-server 參數以本機 CLI 產出的 protocol typings 為準（thread/start、thread/resume、turn/start 的 model；turn/plan/updated 的 plan）。

## 執行與驗證

1. 先加入卡片狀態與轉譯測試，確認 RED，再實作。檢查終態不被延遲事件覆蓋、長輸入符合 Discord 限制、思考內容不外洩。
2. 加入 SessionManager 行為測試，確認一張卡跨越文字/工具/完成，答案不被覆蓋、錯誤可恢復、過期控制不影響新工作。
3. 加入模型隔離與真實 RPC request 測試，再接設定儲存與 UI。確認 resume 也套用新模型。
4. 測試停止確認及跨頻道/過期按鈕；執行相關測試、TypeScript、build 與完整套件。最後做一次獨立 review。

開發在隔離 worktree，以原始未提交內容為 baseline；初次交付只回套本次差異，保留使用者原有修改。後續依使用者授權重啟 bot，並於 2026-10-30 確認將目前 claudecode-discord 修改 squash merge 至 main 後推送。

## 驗證紀錄

- 卡片、事件轉譯、模型隔離、控制項與整合流程均先執行失敗測試，再實作。
- 獨立 review 已重現四項問題：偵測期間停止仍啟動程序、未等待程序退出即宣告停止、超過 30 步時進度總數錯誤、等待問題回答時停止未解除本地等待。四項均新增回歸測試並完成 RED → GREEN，剩餘 review 沒有其他 Important/Critical 發現。
- 提問等待以每次任務的取消訊號解除，涵蓋正在等待回答與提問訊息尚未送達兩種情境；停止完成前必須等頻道清理，舊問題按鈕停用、不再發送後續問題、自訂輸入清除，且恢復可立即啟動。
- 後續修正 Codex app-server 子 agent 完成事件誤結束主任務：只接受目前 thread 與 turn 的完成事件，並排除子 agent 的文字、計畫與模型通知。四項回歸測試涵蓋子 agent 先完成、舊 turn 失敗、缺 thread ID、缺 turn ID。
- 合併前 bot 測試：647 passed，1 項 opt-in Codex E2E skipped；TypeScript 與 build 通過。自動驗證未呼叫付費模型。
- 交付範圍：依使用者確認，納入目前 bot 工作目錄的任務卡、模型設定、session／RPC 修正、skill 指令探索、環境載入與啟動修復，以及尚未合併的串流／wakeup 修正。其他專案與暫存 run-plan 啟動腳本不在此 repository 的合併範圍。
