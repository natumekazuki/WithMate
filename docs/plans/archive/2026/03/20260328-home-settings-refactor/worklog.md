# Worklog

- 2026-03-28: plan を開始。Home の Settings Window に残る async handler と loading/reset 派生状態を helper に分離する。
- 2026-03-28: `src/home-settings-projection.ts` と `src/home-settings-actions.ts` を追加。Settings Window の loading/reset 派生状態と import/export/save/reset の async action を helper に移した。
- 2026-03-28: `77c620c` `refactor(home): extract settings helpers`
  - Settings Window の projection helper を追加
  - import/export/save/reset の action helper を追加
  - `HomeApp.tsx` の Settings async handler を整理
