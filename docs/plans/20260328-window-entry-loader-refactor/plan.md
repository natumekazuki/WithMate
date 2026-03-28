# Plan

- 目的: `main.ts` に残っている renderer entry 読み込み helper を service に分離する
- 完了条件:
  - `home / session / character / diff` の entry load helper が service 化される
  - `devServerUrl` と `dist` の分岐が `main.ts` から外れる
  - `npm run build` と関連 unit test が通る
- スコープ外:
  - window size や title の変更
