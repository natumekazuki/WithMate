# Plan

- 作成日: 2026-03-28
- タスク: Character Reflection Cycle を実装する

## Goal

- `SessionStart` の monologue only path を実装する
- 文脈増加ベースの `character reflection cycle` を実装する
- `CharacterMemoryDelta` と monologue を provider 経由で生成して保存する
- right pane の `独り言` に反映できる最小状態をつなぐ

## Scope

- `src/app-state.ts`
- `src-electron/provider-runtime.ts`
- `src-electron/codex-adapter.ts`
- `src-electron/copilot-adapter.ts`
- `src-electron/character-reflection.ts`
- `src-electron/character-memory-storage.ts`
- `src-electron/main.ts`
- `src/App.tsx`
- 関連 tests
- 関連 design docs / backlog / DB 定義書

## Out Of Scope

- Character definition 自動更新
- monologue 専用 API plane への分離
- 時間減衰 ranking

## Checks

1. `SessionStart` で monologue only path が動く
2. 文脈増加で `CharacterMemoryDelta` と monologue を生成・保存できる
3. `character_memory_entries` と `stream` が更新される
4. background activity / audit に記録される
