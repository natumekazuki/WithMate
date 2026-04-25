# worklog

## 2026-04-25

- SQLite connection 設定が各 storage class に重複していたことを確認した。
- `src-electron/sqlite-connection.ts` を追加し、WAL 設定を共通化した。
- `main.ts` に 5 分間隔の WAL size-based maintenance を追加した。
- `PersistentStoreLifecycleService` に close / recreate 時の WAL truncate checkpoint hook を追加した。
- `docs/design/database-schema.md` と `docs/design/electron-session-store.md` を更新した。
- `npx tsc -p tsconfig.electron.json --noEmit` が成功した。
- `npm run typecheck` は既存の renderer / tests 側 TypeScript errors で失敗した。
- `npm run test -- scripts/tests/sqlite-connection.test.ts scripts/tests/persistent-store-lifecycle-service.test.ts` と `npx tsx --test ...` は sandbox の `spawn EPERM` で失敗した。

## Commit

- 未作成
