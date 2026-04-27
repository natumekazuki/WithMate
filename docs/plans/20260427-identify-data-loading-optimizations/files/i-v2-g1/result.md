# V2 runtime read-path slice (phase 1) 結果

- phase: green
- slice id: `i-v2-g1`
- tdd mode: `green`
- 実施内容:
  - `src-electron/app-database-path.ts` を追加し、`resolveAppDatabasePath(userDataPath)` を実装
  - `src-electron/main.ts` の `dbPath` 初期化を
    `resolveAppDatabasePath(app.getPath("userData"))` に変更
- 検証結果:
  - `npx tsx --test scripts/tests/app-database-path.test.ts`: pass
  - `npm run build:electron`: pass
