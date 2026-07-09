# Plan

- 作成日: 2026-03-28
- タスク: Memory Orchestration のリファクタ

## Goal

- `src-electron/main.ts` に残っている Memory / Character の orchestration を service に分離する
- `Session Memory extraction`、`Project promotion`、`Character reflection`、`background audit` の起動点を整理する
- TDD で trigger / audit / persistence の接続を固定する

## Scope

- `src-electron/main.ts`
- 新しい Memory orchestration service 群
- 関連 tests
- 必要な design doc / plan 更新

## Out Of Scope

- retrieval / ranking ロジック自体の再設計
- provider adapter の全面リファクタ
- renderer 側の activity UI リファクタ

## Checks

1. `main.ts` から Memory / Character の background orchestration が減る
2. trigger / audit / persistence の責務境界が service に集約される
3. background task の主要経路がテストで守られる
