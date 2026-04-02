# worklog

## 2026-04-02

- plan 作成
- review `#6` と current theme helper の重複実装を確認開始
- `src/theme-utils.ts` を共通 helper 化し、hex / luminance / contrast ratio / foreground selection / muted alpha をまとめた
- `src/ui-utils.tsx` の `buildCardThemeStyle()` と `src/CharacterEditorApp.tsx` の editor theme builder を `theme-utils` 正本へ寄せた
- `scripts/tests/theme-utils.test.ts` を追加し、WCAG AA を満たす foreground 選択の回帰を追加した
- `docs/design/desktop-ui.md`、`docs/manual-test-checklist.md`、`docs/task-backlog.md` を current rule に同期した
