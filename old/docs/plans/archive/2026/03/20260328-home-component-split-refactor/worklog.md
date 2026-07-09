# Worklog

- 2026-03-28: plan を開始。HomeApp の大きい UI block を component 単位で分離する。
- 2026-03-28: `src/home-components.tsx` を追加。`Settings content` と `launch dialog` を pure props component に分離した。
- 2026-03-28: `efe5eff` `refactor(home): split settings and launch components`
  - `HomeSettingsContent` と `HomeLaunchDialog` を component 化
  - `HomeApp.tsx` から Settings / launch dialog の大きい JSX block を削減
