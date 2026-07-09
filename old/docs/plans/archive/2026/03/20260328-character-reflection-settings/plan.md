# Plan

- 作成日: 2026-03-28
- タスク: Character Reflection の provider settings を追加する

## Goal

- `Character Reflection` 用に provider ごとの `model / reasoning depth` を Settings から保存できるようにする
- current 実装の app settings / tests / docs を同期する

## Scope

- `src/app-state.ts`
- `src-electron/app-settings-storage.ts`
- `src/HomeApp.tsx`
- `src/settings-ui.ts`
- `scripts/tests/app-settings-storage.test.ts`
- `scripts/tests/model-catalog-settings.test.ts`
- `docs/design/settings-ui.md`
- `docs/design/memory-architecture.md`
- `docs/design/monologue-provider-policy.md`
- `docs/design/database-schema.md`

## Out Of Scope

- `character reflection cycle` の実行
- monologue 実行

## Checks

1. provider ごとの `model / reasoning depth` を保存して再読込できる
2. Settings Window に `Character Reflection` 欄が出る
3. DB 定義書と design が current 実装に追随する
