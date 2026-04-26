# Companion Diff Snapshot 永続化 Worklog

## 2026-04-26

- 実装開始。
- 作業開始時点の worktree は clean。
- `CompanionMergeRun` に `diffSnapshot` を追加し、`companion_merge_runs.diff_snapshot_json` へ保存するようにした。
- 既存 DB には `ALTER TABLE companion_merge_runs ADD COLUMN diff_snapshot_json TEXT NOT NULL DEFAULT '[]'` で migration する。
- merge / discard 完了前に `ChangedFile[]` を作り、cleanup 後の terminal read-only Review Window で latest merge run の diff snapshot を表示するようにした。
- `docs/design/companion-mode.md` と `docs/design/database-schema.md` を current MVP 実装に合わせて更新した。
- `npx tsc -p tsconfig.electron.json --noEmit`、対象 Companion テスト、`npm run build`、`npm test` が通過した。

## コミット記録

| checkpoint | commit | summary |
| --- | --- | --- |
| Companion diff snapshot | 677e38a | merge run に diff snapshot を保存して read-only Review で表示する |
