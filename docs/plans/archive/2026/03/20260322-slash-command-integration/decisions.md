# Decisions

## Summary

- slash command は provider docs を主根拠にして整理する

## Decision Log

### 0001

- 日時: 2026-03-22
- 論点: slash command 調査をどの根拠でまとめるか
- 判断: provider 公式 docs を主根拠とし、必要に応じてローカル SDK 実装や issue を補助根拠に使う
- 理由: slash command は CLI UI 固有機能の可能性があり、二次情報だけで実装判断すると責務を誤りやすいため
- 影響範囲: `docs/design/slash-command-integration.md`, `docs/design/provider-adapter.md`

### 0002

- 日時: 2026-03-22
- 論点: slash command を SDK へ passthrough するか
- 判断: passthrough しない。WithMate が先に parse し、app command または session setting command として扱う
- 理由: Codex / Copilot とも SDK docs に slash command API が見えず、CLI interactive layer の責務とみなすほうが安全なため
- 影響範囲: `docs/design/slash-command-integration.md`, `docs/design/provider-adapter.md`
