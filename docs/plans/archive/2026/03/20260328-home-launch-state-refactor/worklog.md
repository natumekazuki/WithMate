# Worklog

- 2026-03-28: plan を開始。Home の launch dialog state/reset と session input 組み立てを helper に分離する。
- 2026-03-28: `src/home-launch-state.ts` を追加。launch dialog の draft、open/close/reset、workspace 選択、session input 組み立てを helper に移した。
- 2026-03-28: `7375c8b` `refactor(home): extract launch state helpers`
  - launch dialog の state/reset helper を追加
  - session 作成入力の組み立てを helper に移動
  - `HomeApp.tsx` の launch dialog local state を単一 draft に統一
