# Codex 子 agent 完成事件不可結束主任務

## 現象與證據

主任務尚未完成，Discord 卻顯示 `Codex task ended`，整個 Codex app-server 被結束。2026-10-29 16:28:02（台北時間）審查子 agent 回報完成，16:28:03 主任務紀錄為 `turn_aborted`；16:36:48 與 16:36:49 再次出現相同順序。這些中斷先前被誤認為使用者停止，實際與 bot 的事件處理相符。

## 根因

app-server 的通知流包含子 agent 的 thread。`CodexBackend` 沒有過濾 `threadId` 與 `turnId`，收到任何 `turn/completed` 就產生主任務的 `result`。iterator 結束後，finally 呼叫 cleanup 關閉整個 app-server，也中斷尚未完成的主 agent 與其他子 agent。子 agent 的文字、計畫與模型通知也可能污染主任務顯示。

## 修正與驗證

先依目前主 thread 與 turn 過濾通知，再累積文字及轉譯事件。完成事件必須明確符合兩個 ID；缺少 ID 或舊回合的完成事件不會終止任務。

新增四項回歸案例，先確認原程式失敗，再確認修正通過：子 agent 先完成但主 agent 繼續輸出、舊 turn 失敗、缺 thread ID、缺 turn ID。使用真實 JSON-RPC 欄位的測試替身，不呼叫付費推論。
