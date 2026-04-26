# Companion Diff Snapshot 永続化 Result

- status: completed
- started: 2026-04-26
- completed: 2026-04-26

## 結果

- `companion_merge_runs.diff_snapshot_json` に terminal 操作時点の `ChangedFile[]` を保存できるようにした。
- merge / discard 完了時に cleanup 前の diff snapshot を保存するようにした。
- terminal read-only Review Window は latest merge run の diff snapshot を優先して表示し、古い履歴では changed file summary + empty diff rows に fallback する。

## 検証

- `npx tsc -p tsconfig.electron.json --noEmit`
- `npx tsx --test scripts/tests/companion-storage.test.ts scripts/tests/companion-review-service.test.ts`
- `npm run build`
- `npm test`

## コミット

- `677e38a feat(companion): review diff snapshot を保存する`
