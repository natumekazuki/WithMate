# Result

## Status

- 状態: 完了

## Completed

- `Details` 下段を operation timeline へ差し替える実装を追加
- `agent_message` を `MessageRichText` で表示し、command / reasoning と同じ流れで追えるようにした
- 旧 artifact との後方互換として `activitySummary` fallback を残した

## Remaining Issues

- 実機で operation timeline の情報量が過不足ないか確認する

## Related Commits

- `974f437 feat(session): show operation timeline in details`

## Rollback Guide

- 戻し先候補: `974f437`
- 理由: `Details` の operation timeline 導入が 1 論理変更として閉じている

## Related Docs

- `docs/design/desktop-ui.md`
- `docs/design/agent-event-ui.md`
- `docs/manual-test-checklist.md`
