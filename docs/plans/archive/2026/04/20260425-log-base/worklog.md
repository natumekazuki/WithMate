# ログ基盤整備 worklog

## 2026-04-25

- `docs/log-base.md` を起点に、Electron クラッシュ調査向けログ基盤の repo plan を開始した。
- `docs/log-base.md` を精査し、初期実装で採用するログと見送るログを整理した。
- `docs/design/app-log-base.md` を追加し、JSONL 形式、保存先、イベント方針、漏えい防止、Settings 導線を定義した。
- docs-sync 判定として、ログ基盤は現行仕様の追加なので `docs/design/app-log-base.md` と README の導線更新を必要と判断した。`.ai_context/` は存在しないため更新対象なし。
- `src/app-log-types.ts` と `src-electron/app-log-service.ts` を追加し、Main Process 集約の JSONL ロガーを実装した。
- `src-electron/main.ts` に crashReporter 起動、app lifecycle、process exception、BrowserWindow/WebContents、IPC/Renderer ログの結線を追加した。
- `src-electron/preload-api.ts`、`src/withmate-window-api.ts`、`src/withmate-ipc-channels.ts`、Settings UI にログフォルダとクラッシュダンプフォルダの操作を追加した。
- `scripts/tests/app-log-service.test.ts` を追加し、既存 IPC / preload API テストを新 API に追従した。
- `npm run typecheck` と対象テストを実行したが、`node_modules` が無く `tsc` / `tsx` が見つからないため検証は未完了。
- review 指摘を受け、`src-electron/main-ipc-registration.ts` の IPC error logging wrapper が `IpcMain` 全体を偽装しないように修正した。登録関数は `handle` だけを持つ `IpcHandleRegistrar` を受け取り、`ipcMain.on` は実 `ipcMain` に直接登録する。
- ユーザー指示により、検証未完了の状態で plan を archive する。
