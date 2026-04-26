# Companion Merge Runs 実装 Worklog

## 2026-04-26

- 実装開始。
- 作業開始時点の worktree は clean。
- `CompanionMergeRun` 型と clone helper を追加した。
- `companion_merge_runs` table、index、storage API を追加した。
- merge / discard 完了時に completed merge run を保存するようにした。
- main の CompanionReviewService wiring に merge run 保存依存を追加した。
- `docs/design/companion-mode.md` と `docs/design/database-schema.md` を現行仕様に合わせて更新した。
- `npx tsc -p tsconfig.electron.json --noEmit` を実行し、成功した。
- `npx tsx --test scripts/tests/companion-storage.test.ts scripts/tests/companion-review-service.test.ts scripts/tests/companion-session-service.test.ts scripts/tests/main-ipc-deps.test.ts` を実行し、成功した。
- `npm run build` を実行し、成功した。
- `npm test` を実行し、成功した。

## コミット記録

| checkpoint | commit | summary |
| --- | --- | --- |
| Companion merge runs | d4983c8 | merge / discard の terminal 操作履歴を table 化する |
