# Plan

- 作成日: 2026-03-28
- タスク: Session UI projection のリファクタ

## Goal

- `src/App.tsx` に集まっている right pane / telemetry / background activity の派生状態を view model に分離する
- `LatestCommand / MemoryGeneration / Monologue` と provider telemetry の表示ロジックを純関数へ寄せる
- Session renderer の回帰を出しにくい構造へ近づける

## Scope

- `src/App.tsx`
- 新しい session view model helper
- 関連 tests
- 必要な docs / plan 更新

## Out Of Scope

- Session UI の見た目変更
- background activity の backend 実装変更

## Checks

1. `App.tsx` の right pane 周辺の派生状態が helper に分かれる
2. background activity / telemetry の表示ルールが test で守られる
3. renderer の責務が表示と event handler に寄る
