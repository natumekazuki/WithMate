# Plan

- 作成日: 2026-03-28
- タスク: Home panel component のリファクタ

## Goal

- `HomeApp.tsx` に残っている `Recent Sessions` と `Home right pane` の JSX block を component に分離する
- `HomeApp.tsx` を state / effect / handler の composition 層に寄せる

## Scope

- `src/HomeApp.tsx`
- `src/home-components.tsx`
- 必要な docs / plan 更新

## Out Of Scope

- UI の見た目変更
- state 管理方式の変更

## Checks

1. `Recent Sessions` と `Home right pane` が component 化される
2. `HomeApp.tsx` の JSX block がさらに減る
3. `npm run build` が通る
