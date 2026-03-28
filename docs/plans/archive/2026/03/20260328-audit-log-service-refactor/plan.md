# Plan

- 目的: `main.ts` に残っている audit log の `list / create / update / clear` write path を service に分離する
- 完了条件:
  - `src-electron/audit-log-service.ts` が追加される
  - `main.ts` の audit log 呼び出しが service 経由になる
  - `npm run build` と関連 unit test が通る
- スコープ外:
  - `AuditLogStorage` の schema や read/write 仕様変更
