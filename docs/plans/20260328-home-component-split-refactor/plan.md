# Plan

- 作成日: 2026-03-28
- タスク: Home component split のリファクタ

## Goal

- `HomeApp.tsx` に残っている大きい UI block を component 単位で分離する
- `Recent Sessions`、`Home right pane`、`launch dialog`、`settings content` のうち props が閉じるものから順に外へ出す
- `HomeApp.tsx` を state / effect / handler の結線に寄せる

## Scope

- `src/HomeApp.tsx`
- 新しい Home 用 component module
- 必要な docs / plan 更新

## Out Of Scope

- UI の見た目変更
- Home の state 管理方式の全面変更

## Checks

1. `HomeApp.tsx` の JSX ブロックが減る
2. 切り出した component は pure props で描画できる
3. `npm run build` が通る
