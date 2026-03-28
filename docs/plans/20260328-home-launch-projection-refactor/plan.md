# Plan

- 作成日: 2026-03-28
- タスク: Home launch projection のリファクタ

## Goal

- `HomeApp.tsx` に残っている launch dialog / character list の派生状態を pure helper に分離する
- launch provider / character 選択、empty message、workspace 表示の表示ルールを test で守る
- Home renderer の責務を描画と event handler に寄せる

## Scope

- `src/HomeApp.tsx`
- 新しい home launch projection helper
- 関連 tests
- 必要な docs / plan 更新

## Out Of Scope

- launch dialog の見た目変更
- session 作成 backend 変更

## Checks

1. launch dialog の provider / character / workspace 派生状態が helper に寄る
2. empty message と selected item の表示ルールが test で守られる
3. `HomeApp.tsx` の launch dialog 用 useMemo / 条件分岐が減る
