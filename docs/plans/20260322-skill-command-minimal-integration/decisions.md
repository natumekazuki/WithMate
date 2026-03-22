# Decisions

## Summary

- `/skill` は最小実装を先に入れ、skill picker と prompt 挿入に責務を絞る

## Decision Log

### 0001

- 日時: 2026-03-22
- 論点: `/skill` の最小実装をどこまでに絞るか
- 判断: provider root + workspace の skill 一覧化、picker、composer 挿入までに絞る
- 理由: slash command の価値検証を先に行いたく、skill 管理 UI や実行可否検証まで広げると初手が重くなるため
- 影響範囲: `docs/design/skill-command-design.md`, `docs/design/slash-command-integration.md`
