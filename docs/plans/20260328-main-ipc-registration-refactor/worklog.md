# Worklog

- 2026-03-28: plan 作成
- 2026-03-28: `main-ipc-registration.ts` を追加し、`app.whenReady()` の `ipcMain.handle(...)` 群を register helper 経由へ置換
- 2026-03-28: `resolveEventWindow` を DI に寄せて、node test から Electron runtime import を外した
- 2026-03-28: `npm run build`
- 2026-03-28: `node --test --import tsx scripts/tests/main-ipc-registration.test.ts scripts/tests/aux-window-service.test.ts scripts/tests/window-entry-loader.test.ts scripts/tests/window-dialog-service.test.ts`
