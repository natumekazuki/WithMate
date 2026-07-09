# Plan

- タスク: `app-state.ts` に残っている character shared type / helper を分離する
- スコープ:
  - `src/app-state.ts`
  - `src/character-state.ts`
  - `src/` / `src-electron/` / `scripts/tests/` の関連 import 更新
- 非スコープ:
  - session runtime の挙動変更
  - Session domain の型分割

## Steps

1. character domain の型と helper を新 module へ切り出す
2. `app-state.ts` を re-export 中心へ整理する
3. 関連 import を更新し、build と character 系テストを通す
