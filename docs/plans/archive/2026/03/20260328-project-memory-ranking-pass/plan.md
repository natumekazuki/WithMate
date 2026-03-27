# Plan

- 作成日: 2026-03-28
- タスク: Project Memory retrieval / ranking を 1 段強化する

## Goal

- lexical retrieval のノイズを減らす
- query と関係が薄い entry の混入を抑える
- 同義に近い entry が prompt に重複注入されるのを防ぐ

## Scope

- `src-electron/project-memory-retrieval.ts`
- `scripts/tests/project-memory-retrieval.test.ts`
- 関連 design doc

## Out Of Scope

- 時間減衰
- vector retrieval
- embedding / FTS
- Character Memory retrieval

## Checks

1. query coverage を使って score が改善される
2. 低スコア entry が prompt 注入対象から外れる
3. 重複に近い entry が同時に返りにくくなる
