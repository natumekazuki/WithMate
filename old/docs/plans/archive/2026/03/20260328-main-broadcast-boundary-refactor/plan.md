# Plan

- 目的: `main.ts` に残っている window 向け broadcast helper を境界ごとに整理し、window runtime と state/runtime service の責務を明確にする
- 完了条件:
  - broadcast helper の責務が domain 単位で整理される
  - `main.ts` の直列な `BrowserWindow.getAllWindows()` 送信処理が減る
  - `npm run build` と関連 unit test が通る
- スコープ外:
  - IPC channel 名や renderer 契約の変更
  - window lifecycle 全体の再設計
