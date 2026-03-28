# Worklog

- 2026-03-28: plan を開始。Home の launch dialog / character list 派生状態を helper に分離する。
- 2026-03-28: `src/home-launch-projection.ts` を追加。launch dialog の provider / character / workspace 派生状態を helper に移し、`scripts/tests/home-launch-projection.test.ts` で検索と開始可否を固定。
- 2026-03-28: `eefa486` `refactor(home): extract launch projection helpers`
  - launch dialog の projection helper を追加
  - `HomeApp.tsx` から launch dialog 派生状態を移動
  - `home-launch-projection.test.ts` を追加して検索 / start 可否を固定
