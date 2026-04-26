# Companion History Display 実装 Decisions

## 2026-04-26

- 初期履歴表示は既存 `companion_sessions.status` を使い、専用 history table は追加しない。
- terminal CompanionSession は Home の履歴カードとして表示し、Review Window は active のみ開ける。
