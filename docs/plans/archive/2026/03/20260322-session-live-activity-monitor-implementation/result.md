# Result

## Status

- 状態: 完了

## Completed

- `pending bubble` から `live run step` 一覧を外し、composer 直上の `Activity Monitor` へ分離した
- message list と `Activity Monitor` の scroll / follow を独立させ、chat 本文と command 実況の両方で最新を追えるようにした
- `docs/design/desktop-ui.md`、`docs/design/session-live-activity-monitor.md`、`docs/manual-test-checklist.md` を実装に合わせて更新した

## Remaining Issues

- なし

## Related Commits

- `c567902` `feat(session): split live activity monitor`

## Rollback Guide

- 戻し先候補: `207e6e5`
- 理由: `Activity Monitor` 実装前の直近 commit

## Related Docs

- `docs/design/session-live-activity-monitor.md`
- `docs/design/desktop-ui.md`
- `docs/manual-test-checklist.md`
