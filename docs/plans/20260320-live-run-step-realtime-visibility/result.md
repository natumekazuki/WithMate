# Result

## Status

- 状態: 実装完了
- フェーズ: UI / docs 更新済み、実機確認待ち

## Completed

- リアルタイム可視性重視の新規 plan を作成した
- current baseline と user 要求に合わせて plan を補正し、`command_execution`・`assistantText`・補助情報ブロックの扱いを明文化した
- `pre-e63c911` と current baseline の差分を棚卸しし、戻す対象を `command_execution` の主表示と step 主体の進行中感に限定した
- pending bubble で `command_execution` を dedicated command block 表示へ変更し、completed 後も command の視認性を維持した
- `assistantText` 未着時の実行中 indicator、`details` ラベル整理、design doc / manual test 更新を反映した
- same-plan review 指摘に対応し、`assistantText` 未着でも `in_progress` step が無い限り `実行中` indicator を出さないよう局所修正した

## Remaining Issues

- 実機で `assistantText` 未着時の pending bubble 視認性を確認する
- 実機で completed-only step / failed + error block の否定ケースが `実行中` と競合しないか確認する
- 実データで長い command / aggregated output の折りたたみ挙動を確認する

## Related Commits

- なし

## Rollback Guide

- 戻し先候補: `0fdacf9`
- 理由: current baseline の `file_change` visibility-first 改善を維持したまま、今回追加した command block / running indicator / doc 更新のみを切り戻せる

## Related Docs

- `docs/design/desktop-ui.md`
- `docs/manual-test-checklist.md`
- `docs/plans/20260320-live-run-step-realtime-visibility/plan.md`
