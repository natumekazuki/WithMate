# Plan

- 目的: `main.ts` に残っている pending approval request の待機 / resolve / live run 同期を service に分離する
- 完了条件:
  - `src-electron/session-approval-service.ts` が追加される
  - `main.ts` の `waitForLiveApprovalDecision` / `resolveLiveApproval` が service 経由になる
  - `npm run build` と関連 unit test が通る
- スコープ外:
  - approval UI や provider callback の仕様変更
