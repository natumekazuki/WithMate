# Plan

- 作成日: 2026-03-28
- タスク: Project Memory retrieval を強化する

## Goal

- 日本語中心の query でも `Project Memory` を拾いやすくする
- retrieval に title / detail / keywords の重み差を持たせる
- prompt に注入した entry の `lastUsedAt` を更新する

## Scope

- `src-electron/project-memory-retrieval.ts`
- `src-electron/project-memory-storage.ts`
- `src-electron/main.ts`
- 必要な test
- 関連 design doc / DB 定義書

## Out Of Scope

- vector retrieval
- decay
- FTS5
- renderer UI

## Checks

1. 日本語 query でも relevant な entry を拾える
2. title / keywords の一致が detail より強く効く
3. 注入した entry の `lastUsedAt` が更新される
4. docs と tests が current 実装へ同期している
