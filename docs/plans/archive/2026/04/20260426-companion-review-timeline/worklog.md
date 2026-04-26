# Companion Review Timeline 実装 Worklog

## 2026-04-26

- 実装開始。
- 作業開始時点の worktree は clean。
- `CompanionReviewSnapshot` に `mergeRuns` を追加し、active / terminal の Review snapshot へ session の merge runs を含めるようにした。
- Review Window に merge / discard の timeline を追加し、selected files、changed files、sibling warning 件数を短く表示するようにした。
- `docs/design/companion-mode.md` と `docs/design/database-schema.md` を current MVP 実装に合わせて更新した。
- `npx tsc -p tsconfig.electron.json --noEmit`、対象 Companion テスト、`npm run build`、`npm test` が通過した。

## コミット記録

| checkpoint | commit | summary |
| --- | --- | --- |
| Companion review timeline | 77ae968 | Review Window に merge run timeline を表示する |
