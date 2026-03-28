# Plan

- 作成日: 2026-03-28
- タスク: Session modal component のリファクタ

## Goal

- `App.tsx` に残っている `Diff modal` と `Audit Log modal` を component に分離する
- `App.tsx` を state / effect / handler / composition の責務に寄せる

## Scope

- `src/App.tsx`
- `src/session-components.tsx`
- 必要な docs / plan 更新

## Out Of Scope

- modal の見た目変更
- Audit Log の表示内容変更

## Checks

1. `Diff modal` と `Audit Log modal` が component 化される
2. `App.tsx` の下端 modal JSX block が減る
3. `npm run build` が通る
