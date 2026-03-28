# Plan

- 作成日: 2026-03-28
- タスク: Session context pane component のリファクタ

## Goal

- `App.tsx` に残っている `context pane` を component に分離する
- `App.tsx` を state / effect / handler / composition の責務に寄せる

## Scope

- `src/App.tsx`
- `src/session-components.tsx`
- 必要な docs / plan 更新

## Out Of Scope

- `action dock` の分離
- 右ペインの見た目変更

## Checks

1. `context pane` が component 化される
2. `App.tsx` の右ペイン JSX block が減る
3. `npm run build` が通る
