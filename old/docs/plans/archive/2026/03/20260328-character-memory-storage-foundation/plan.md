# Plan

- 作成日: 2026-03-28
- タスク: Character Memory の保存基盤を実装する

## Goal

- `character_scopes` と `character_memory_entries` の SQLite 保存基盤を追加する
- main process から `Character Memory` を参照・初期化できる状態にする
- reset 導線と DB 定義書まで current 実装に同期する

## Scope

- `src/app-state.ts`
- `src-electron/character-memory-storage.ts`
- `src-electron/main.ts`
- `scripts/tests/character-memory-storage.test.ts`
- `docs/design/character-memory-storage.md`
- `docs/design/database-schema.md`
- `docs/design/settings-ui.md`
- `docs/manual-test-checklist.md`

## Out Of Scope

- `character reflection cycle` の実行実装
- `独り言` 生成
- renderer UI

## Checks

1. `Character Memory` 用 table が SQLite に作成される
2. `character id` 単位で scope と entry を保存できる
3. `DB を初期化` から `character memory` を個別に消せる
