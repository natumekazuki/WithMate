# Plan

- 作成日: 2026-03-28
- タスク: Home character projection のリファクタ

## Goal

- `HomeApp.tsx` の Characters 右ペインに残っている検索結果と empty state の派生状態を helper に分離する
- character search の一致条件と empty state を test で固定する
- Characters 表示の条件分岐を `HomeApp.tsx` から減らす

## Scope

- `src/HomeApp.tsx`
- 新しい home character projection helper
- 関連 tests
- 必要な docs / plan 更新

## Out Of Scope

- Characters UI の見た目変更
- Character Editor backend 変更

## Checks

1. Characters の filtered list と empty state が helper に寄る
2. search と empty state の表示ルールが test で守られる
3. `HomeApp.tsx` の Characters 条件分岐が減る
