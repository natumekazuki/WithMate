# Plan

- タスク: `app-state.ts` に集中している Memory / background activity 系の shared type と helper を domain 単位で分離する
- スコープ:
  - `src/app-state.ts`
  - `src/` / `src-electron/` / `scripts/tests/` の関連 import 更新
  - memory / background activity の shared type と normalize helper
- 非スコープ:
  - Session / Character / Settings 全体の型分割
  - runtime 挙動変更

## Steps

1. `app-state.ts` から切り出す Memory / background activity 領域を特定する
2. 新しい domain module へ移し、import を更新する
3. 既存テストと build を通し、refactor roadmap を更新する
