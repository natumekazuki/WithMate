# Companion Sibling Warning History 実装 Worklog

## 2026-04-26

- 実装開始。
- 作業開始時点の worktree は clean。
- `CompanionSession` / `CompanionSessionSummary` に sibling warning summary を追加した。
- `companion_sessions.sibling_warnings_json` を追加し、既存 DB 向け migration を追加した。
- merge 完了時に sibling warning を terminal session へ保存するようにした。
- discard 完了時は sibling warning を空配列で保存するようにした。
- Home の terminal 履歴カードで sibling warning summary を表示するようにした。
- `docs/design/companion-mode.md` と `docs/design/database-schema.md` を現行仕様に合わせて更新した。
- `npx tsc -p tsconfig.electron.json --noEmit` を実行し、成功した。
- `npx tsx --test scripts/tests/companion-storage.test.ts scripts/tests/companion-review-service.test.ts scripts/tests/companion-session-service.test.ts` を実行し、成功した。
- `npm run build` を実行し、成功した。
- `npm test` を実行し、成功した。

## コミット記録

| checkpoint | commit | summary |
| --- | --- | --- |
| Companion sibling warning history | ceadf2c | merge 完了時の sibling warning を履歴に保存して表示する |
