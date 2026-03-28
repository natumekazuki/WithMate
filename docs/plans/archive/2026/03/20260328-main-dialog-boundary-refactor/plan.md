# Plan

- 目的: `main.ts` に残っている `dialog.showOpenDialog / showSaveDialog` ベースの helper を service に分離する
- 完了条件:
  - file picker と model catalog import-export 向け dialog helper が service 化される
  - `main.ts` の dialog 分岐が減る
  - `npm run build` と関連 unit test が通る
- スコープ外:
  - dialog 文言や filter の仕様変更
