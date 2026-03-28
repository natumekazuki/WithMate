# Plan

- 作成日: 2026-03-28
- タスク: Settings / Catalog 境界のリファクタ

## Goal

- `app settings` と `model catalog` の参照・正規化経路を整理する
- `main.ts` と `HomeApp.tsx` に散っている settings / catalog の責務を service / view model 境界へ寄せる
- provider ごとの `model / reasoning / threshold` 設定の扱いを一本化する

## Scope

- `src-electron/main.ts`
- `src-electron/app-settings-storage.ts`
- `src-electron/model-catalog-storage.ts`
- 新しい settings / catalog service
- `src/HomeApp.tsx`
- 関連 tests
- 必要な design doc / plan 更新

## Out Of Scope

- settings UI の見た目刷新
- model catalog schema 自体の変更
- memory / character retrieval のロジック変更

## Checks

1. settings / catalog の read / normalize / fallback 経路が service に集約される
2. `HomeApp.tsx` の form state 組み立てが薄くなる
3. provider ごとの `model / reasoning / threshold` 設定が共通の扱いで読める
