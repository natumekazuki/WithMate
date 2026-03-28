# Plan

- 目的: `main.ts` に残っている composition root を整理し、`require*` 群と app lifecycle を見通しよくする
- 完了条件:
  - `main.ts` の service wiring と app lifecycle の責務が読みやすく整理される
  - `whenReady / activate / window-all-closed / before-quit` で何をしているか追いやすくなる
  - `npm run build` と関連 unit test が通る
- スコープ外:
  - IPC payload や service の public API 仕様変更
