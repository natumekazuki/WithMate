# Plan

- 目的: `main.ts` に残っている `live run / provider quota telemetry / session context telemetry / background activity` の state と timer 管理を service に分離する
- 完了条件:
  - `src-electron/session-observability-service.ts` が追加される
  - `main.ts` の observability state と timer 管理が service 経由になる
  - `npm run build` と関連 unit test が通る
- スコープ外:
  - audit log storage 自体の移設
  - IPC 契約や UI 表示仕様の変更
