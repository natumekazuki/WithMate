# Plan

- タスク: `app-state.ts` に残っている provider config / app settings の shared type と normalize helper を分離する
- スコープ:
  - `src/app-state.ts`
  - `src/` / `src-electron/` / `scripts/tests/` の関連 import 更新
  - provider config、memory extraction config、character reflection config の shared helper
- 非スコープ:
  - Session / Character domain の型分割
  - settings runtime 挙動変更

## Steps

1. `app-state.ts` から切り出す provider config 領域を特定する
2. 新しい domain module へ移し、import を更新する
3. 既存テストと build を通し、refactor roadmap を更新する
