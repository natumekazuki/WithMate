# Result

- 状態: completed

## メモ

- `ipcMain.handle(...)` の登録を `src-electron/main-ipc-registration.ts` へ移し、`main.ts` の `app.whenReady()` を短くした
- event 由来の target window 解決も DI に寄せ、unit test から直接 Electron runtime import しない形へ整理した
