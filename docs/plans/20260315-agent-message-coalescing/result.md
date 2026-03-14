# Result

## Status

- 状態: 進行中

## Completed

- `turn.items` に複数の `agent_message` が含まれる場合でも、Session chat と live pending bubble で欠落なく表示する実装を入れた
- `agent_message` の個別粒度は `Operations` と `Raw Items` に残しつつ、UI 向け assistant text だけを arrival 順に連結する方針を文書化した
- 実機テスト項目に複数 `agent_message` ケースを追加した

## Remaining Issues

- コミット作成後に関連ハッシュを記録する
- 実機で複数 `agent_message` を返すケースの手触り確認がまだ

## Related Commits

- 未作成

## Rollback Guide

- 戻し先候補: このタスクのコミット作成後に記入
- 理由: まだ作業中

## Related Docs

- `docs/design/provider-adapter.md`
- `docs/design/audit-log.md`
- `docs/manual-test-checklist.md`
