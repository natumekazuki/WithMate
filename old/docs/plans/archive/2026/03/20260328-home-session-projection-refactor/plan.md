# Plan

- 作成日: 2026-03-28
- タスク: Home session projection のリファクタ

## Goal

- `HomeApp.tsx` に集まっている session list / monitor の派生状態を pure helper に分離する
- search / monitor grouping / empty message の表示ルールを test で守る
- Home renderer の責務を描画と event handler に寄せる

## Scope

- `src/HomeApp.tsx`
- 新しい home session projection helper
- 関連 tests
- 必要な docs / plan 更新

## Out Of Scope

- Home UI の見た目変更
- session launch / window backend 変更

## Checks

1. session search / monitor grouping が helper に寄る
2. empty message の表示ルールが test で守られる
3. `HomeApp.tsx` の session monitor 派生ロジックが減る
