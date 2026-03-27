# Worklog

## 2026-03-27

- plan を作成
- `project-memory-storage.md` と current store 実装の接点確認を開始
- `src-electron/project-scope.ts` を追加し、`workspacePath` から `git | directory` の project scope を解決できるようにした
- `src-electron/project-memory-storage.ts` を追加し、`project_scopes` / `project_memory_entries` の SQLite storage を実装した
- `src-electron/main.ts` に storage 初期化、session 保存時同期、DB reset target の接続を入れた
- `scripts/tests/project-memory-storage.test.ts` を追加し、scope 解決と entry upsert を確認した
- `docs/design/project-memory-storage.md`、`docs/design/database-schema.md` などを current 実装へ同期した
