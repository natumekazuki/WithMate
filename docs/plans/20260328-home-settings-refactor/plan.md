# Plan

- 作成日: 2026-03-28
- タスク: Home settings のリファクタ

## Goal

- `HomeApp.tsx` に残っている Settings Window の async handler と loading/reset の派生状態を helper に分離する
- settings save / import / export / reset の挙動を test で固定する
- `HomeApp.tsx` の Settings 責務を state 適用と描画に寄せる

## Scope

- `src/HomeApp.tsx`
- 新しい home settings projection / actions helper
- 関連 tests
- 必要な docs / plan 更新

## Out Of Scope

- Settings UI の見た目変更
- backend service の仕様変更

## Checks

1. Settings の loading/reset 派生状態が helper に寄る
2. settings async handler の文言と戻り値処理が test で守られる
3. `HomeApp.tsx` の Settings async handler が薄くなる
