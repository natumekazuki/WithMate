# Plan

- status: in_progress
- goal: `Project Memory` の保存設計を v1 として定義し、Git / NotGit 両対応の project identity と SQLite schema を固める。
- scope:
  - `Project Memory` の責務と `Session Memory` との差分を保存観点で整理する
  - `project` identity の決め方を `git | directory` で定義する
  - SQLite の table / column / index 案を作る
  - `Session -> Project` 昇格時に必要な最小 metadata を決める
- out_of_scope:
  - 実装
  - embedding / vector search
  - retrieval ranking
