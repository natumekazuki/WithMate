# Decisions

## Summary

- `turn.items` に複数の `agent_message` がある場合でも、Session UI では 1 本の assistant text に連結して欠落なく表示する

## Decision Log

### 0001

- 日時: 2026-03-15
- 論点: 1 turn 内で複数の `agent_message` が返る場合の Session UI 表示
- 判断: chat UI と live pending bubble では、複数の `agent_message` を arrival 順に空行区切りで連結して 1 本の assistant text として扱う
- 理由: 現行 UI は 1 turn = 1 assistant message 前提で構成されており、最後の 1 件だけを残すと応答が欠けるため。個別 item の粒度は監査ログの `Operations` と `Raw Items` に残る
- 影響範囲: `src-electron/codex-adapter.ts`, `docs/design/provider-adapter.md`, `docs/design/audit-log.md`, `docs/manual-test-checklist.md`
