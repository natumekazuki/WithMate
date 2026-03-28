# Plan

- 目的: `main.ts` に並んでいる `ipcMain.handle(...)` 群を register helper に分離する
- 完了条件:
  - window / settings / session / character / file dialog の IPC 登録が helper 経由になる
  - `main.ts` の `app.whenReady()` 内が短くなる
  - `npm run build` と関連 unit test が通る
- スコープ外:
  - channel 名や IPC payload 仕様の変更
