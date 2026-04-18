# Worklog

- 2026-04-19: review-0650 (`docs/reviews/review-20260419-0650.md`) の指摘を調査した。`src-electron/snapshot-ignore.ts:217-220` で `EACCES` / `EPERM` / `EBUSY` を 1 回で `kind: "unreadable"` に確定しており、scan 中の retry が使われないことを確認した。
- 2026-04-19: 影響範囲を確認した。同一 scan で race-like エラーと stable unreadable が混在する場合の優先順位も問題範囲と判断し、Decision 2 を追加した。
- 2026-04-19: `src-electron/snapshot-ignore.ts` を修正した。transient エラー（`EACCES` / `EPERM` / `EBUSY`）は scan 内 retry で吸収し、retry 上限到達後のみ `unreadable` に降格するよう変更した。stable unreadable と race-like 混在時は `race` を優先するロジックも追加した。
- 2026-04-19: `scripts/tests/workspace-file-search.test.ts` に回帰テストを追加した。transient エラーが retry で吸収されること、retry 上限到達で `unreadable` になること、race 優先ロジックの各ケースを網羅した。
- 2026-04-19: `docs/reviews/` 配下の全 review ファイル削除を実施（予定 → 完了）。対象: `review-20260329-1438.md`, `review-20260419-0237.md`, `review-20260419-0314.md`, `review-20260419-0444.md`, `review-20260419-0553.md`, `review-20260419-0650.md` の計 6 ファイル。
- 2026-04-19: 検証実施。`node --import tsx scripts/tests/workspace-file-search.test.ts` → 21/21 PASS。`npm run build` → success。`npm run typecheck` → repo-wide 既知問題の継続で fail。今回変更ファイル起因の新規 failure は未観測。
