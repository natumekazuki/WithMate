# Plan

- 作成日: 2026-03-28
- タスク: provider settings 正規化経路のリファクタ

## Goal

- `coding / memory extraction / character reflection` の provider settings 解決と draft 更新の重複を減らす
- renderer と main process で同じ正規化ルールを共有しやすい構造に寄せる
- `HomeApp.tsx` の settings 編集ロジックをさらに薄くする

## Scope

- `src/app-state.ts`
- `src/home-settings-view-model.ts`
- `src/home-settings-draft.ts`
- `src/HomeApp.tsx`
- 関連 tests
- 必要な docs / plan 更新

## Out Of Scope

- Settings UI の見た目変更
- storage schema 変更
- provider adapter の挙動変更

## Checks

1. provider settings の解決・参照が helper 経由に寄る
2. draft 更新が一貫した構造を使う
3. `HomeApp.tsx` の settings 派生ロジックが減る
