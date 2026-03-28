# Plan

- タスク: `app-state.ts` に残っている Session shared type / helper を分離する
- スコープ:
  - `src/app-state.ts`
  - 新しい Session domain module
  - `src/` / `src-electron/` / `scripts/tests/` の関連 import 更新
- 非スコープ:
  - audit / telemetry type の分離
  - session runtime の振る舞い変更

## Steps

1. Session domain の型と helper を切り出す対象を確定する
2. 新 module へ移し、`app-state.ts` を re-export 中心へ整理する
3. 関連 import を更新し、build と Session 系テストを通す
