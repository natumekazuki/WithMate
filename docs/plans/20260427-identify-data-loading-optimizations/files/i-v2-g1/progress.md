# V2 runtime read-path slice (phase 1) 進捗

- ステータス: 完了
- 対象範囲:
  - `src-electron/app-database-path.ts` 新規追加
  - `src-electron/main.ts` の DB パス解決を新実装へ切替
- 目的: Red test `scripts/tests/app-database-path.test.ts` が要求する
  `resolveAppDatabasePath` の挙動を満たし、起動時 DB 選択を v2 優先にする
- 検証:
  - `npx tsx --test scripts/tests/app-database-path.test.ts`
  - `npm run build:electron`
