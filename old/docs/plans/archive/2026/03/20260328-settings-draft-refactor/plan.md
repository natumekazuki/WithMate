# Plan

- 作成日: 2026-03-28
- タスク: Settings draft 更新ロジックのリファクタ

## Goal

- `src/HomeApp.tsx` に残っている settings draft 更新ロジックを pure helper に分離する
- provider ごとの `enabled / apiKey / skillRootPath / model / reasoning / threshold` 更新を一貫した関数で扱う
- renderer 側の state 更新をテストで守れる形にする

## Scope

- `src/HomeApp.tsx`
- 新しい settings draft helper
- 関連 tests
- 必要な docs / plan 更新

## Out Of Scope

- settings UI の見た目変更
- Main Process 側の settings service 変更

## Checks

1. `HomeApp.tsx` の settings handler が薄くなる
2. provider ごとの draft 更新ルールが helper へ集約される
3. draft 更新ロジックが unit test で守られる
