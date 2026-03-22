# Worklog

## Timeline

### 0001

- 日時: 2026-03-22
- チェックポイント: Plan 作成
- 実施内容: `Activity Monitor` 実装 plan を作成した
- 検証: 未実施
- メモ: 次は `pending bubble` から live step list を外し、monitor 側へ移す
- 関連コミット: なし

### 0002

- 日時: 2026-03-22
- チェックポイント: `Activity Monitor` 実装と docs 同期
- 実施内容: `pending bubble` を会話本文専用に寄せ、`live run step` を composer 直上の `Activity Monitor` へ分離した。message list と monitor の follow state を独立させ、`docs/design/desktop-ui.md`、`docs/design/session-live-activity-monitor.md`、`docs/manual-test-checklist.md` を同期した
- 検証: `npm run typecheck`、`npm run build`
- メモ: `npm run build` は sandbox の `spawn EPERM` を避けるため権限付きで再実行した。`.ai_context/` と `README.md` は今回の UI 構造変更では不要と判断した
- 関連コミット: なし

## Open Items

- なし
