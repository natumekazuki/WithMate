# Worklog

- 2026-04-19: `review-20260419-0553.md` を確認し、P2（query cache 上限）と P3（stable unreadable の `race` 誤分類）を整理した。
- 2026-04-19: 直前の archive plan `docs/plans/archive/2026/04/20260419-review-ignore-race-invalidation/` を参照し、sentinel 設計を前提にせず ignore 状態の明示設計へ切り替える方針を検討した。
- 2026-04-19: 新しい repo plan を作成した。
- 2026-04-19: `src-electron/workspace-file-search.ts` に query cache helper（recent cache / 上限排出 / test helper）を追加した。
- 2026-04-19: `src-electron/snapshot-ignore.ts` に `unreadable` 分類、read override hook、`IgnoreFileState` を追加し、`race` と分離した。
- 2026-04-19: `scripts/tests/workspace-file-search.test.ts` に query cache cap テスト 1 件と stable unreadable テスト 1 件を追加し、既存 0444 race テストの説明を更新した。
- 2026-04-19: `node --import tsx scripts/tests/workspace-file-search.test.ts` が 19/19 PASS、`npm run build` が success、`npm run typecheck` は既知の repo-wide エラーで fail であることを確認した。

## メモ

- P2 は `workspace-file-search.ts` の query cache 更新点を中心に修正する。
- P3 は `snapshot-ignore.ts` の `readFile()` エラー分類と、`workspace-file-search.ts` の ignore 状態再検証をセットで見直す必要がある。
- query cache 上限は `DEFAULT_WORKSPACE_QUERY_CACHE_MAX_ENTRIES = 200` を採用した。
- stable unreadable の再評価は `DEFAULT_UNREADABLE_IGNORE_RETRY_INTERVAL_MS = DEFAULT_WORKSPACE_FILE_INDEX_TTL_MS * 10` とした。
