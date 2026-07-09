# Result

## Status

- 状態: 完了

## Completed

- Audit Log を `1 turn = 1 レコード` の保存モデルへ切り替える実装を追加
- UI の phase 表示を `RUNNING / DONE / FAIL` に揃えた

## Remaining Issues

- 旧 `started`/`completed` 2 レコード時代の履歴は DB に残るため、過去ログには重複表示が残る

## Related Commits

- `e11c84e fix(audit-log): store one record per turn`

## Rollback Guide

- 戻し先候補: `e11c84e`
- 理由: Audit Log の記録単位変更が 1 論理変更として閉じている

## Related Docs

- `docs/design/audit-log.md`
- `docs/manual-test-checklist.md`
