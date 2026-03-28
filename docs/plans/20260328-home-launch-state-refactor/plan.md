# Plan

- 作成日: 2026-03-28
- タスク: Home launch state のリファクタ

## Goal

- `HomeApp.tsx` に残っている launch dialog の state/reset と session input 組み立てを pure helper に分離する
- launch dialog の open/close/reset ルールと session 作成入力を test で固定する
- Home renderer の責務を描画と event handler にさらに寄せる

## Scope

- `src/HomeApp.tsx`
- 新しい home launch state helper
- 関連 tests
- 必要な docs / plan 更新

## Out Of Scope

- launch dialog の見た目変更
- session 作成 backend 変更

## Checks

1. launch dialog の open/close/reset ルールが helper に寄る
2. session 作成入力の組み立てが helper に寄る
3. `HomeApp.tsx` の launch dialog 用 state 更新ロジックが減る
