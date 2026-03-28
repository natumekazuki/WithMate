# Plan

- 作成日: 2026-03-28
- タスク: Session Runtime Orchestration のリファクタ

## Goal

- `src-electron/main.ts` に集中している session runtime の責務を service へ分離する
- TDD で `session 起動 / 再開 / turn 実行 / in-flight 管理` の振る舞いを固める
- 後続の Memory / Character / UI projection リファクタの土台を作る

## Scope

- `src-electron/main.ts`
- 新しい session runtime service
- 関連 tests
- 必要な design doc / plan 更新

## Out Of Scope

- Memory orchestration の全面分離
- UI リファクタ
- docs 精査

## Checks

1. session runtime の主要責務が service に移る
2. `main.ts` は window / IPC の結線中心になる
3. 新しい service に対するテストが追加される
