# Plan

- 作成日: 2026-03-28
- タスク: Session action dock component のリファクタ

## Goal

- `App.tsx` に残っている `action dock` のうち、まず `retry banner` と `compact row` を component に分離する
- `App.tsx` を state / effect / handler / composition の責務に寄せる

## Scope

- `src/App.tsx`
- `src/session-components.tsx`
- 必要な docs / plan 更新

## Out Of Scope

- expanded composer 全体の分離
- 入力挙動や見た目変更

## Checks

1. `retry banner` と `compact row` が component 化される
2. `App.tsx` の action dock JSX block が減る
3. `npm run build` が通る
