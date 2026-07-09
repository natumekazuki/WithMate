# Result

## Status

- 状態: 完了

## Completed

- `turn.items` に複数の `agent_message` が含まれる場合でも、Session chat と live pending bubble で欠落なく表示する実装を入れた
- `agent_message` の個別粒度は `Operations` と `Raw Items` に残しつつ、UI 向け assistant text だけを arrival 順に連結する方針を文書化した
- 実機テスト項目に複数 `agent_message` ケースを追加した

## Remaining Issues

- 実機で複数 `agent_message` を返すケースの手触り確認がまだ

## Related Commits

- `5439d86 fix(session): preserve multiple agent messages`

## Rollback Guide

- 戻し先候補: `5439d86`
- 理由: 複数 `agent_message` を 1 本の assistant text に連結する変更単位がここで閉じている

## Related Docs

- `docs/design/provider-adapter.md`
- `docs/design/audit-log.md`
- `docs/manual-test-checklist.md`
