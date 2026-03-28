# Plan

- 目的: `main.ts` に残っている persistent store の `initialize / close / recreate` を service に分離する
- 完了条件:
  - DB と storage の初期化・破棄・再生成が service 経由になる
  - `main.ts` から store lifecycle の詳細が減る
  - `npm run build` と関連 unit test が通る
- スコープ外:
  - SQLite schema や reset policy 自体の変更
