# Plan

- 作成日: 2026-03-28
- タスク: Session Memory extraction prompt を調整する

## Goal

- `SessionMemoryDelta` の field ごとの役割を prompt に明示する
- 未確定事項やノイズが `decisions` / `notes` に混ざりにくいようにする
- 既存 merge 方式に合う「差分だけ返す」ルールを強くする

## Scope

- `src-electron/session-memory-extraction.ts`
- `scripts/tests/session-memory-extraction.test.ts`
- 関連 design doc

## Out Of Scope

- schema の変更
- extraction trigger の変更
- Project Memory 昇格ロジックの変更

## Checks

1. prompt に field ごとの role と出力ルールが含まれる
2. `decisions` / `openQuestions` / `nextActions` / `notes` の切り分けが instruction として明文化される
3. tests と docs が current 実装へ同期している
