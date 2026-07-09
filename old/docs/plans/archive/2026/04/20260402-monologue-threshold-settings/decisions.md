# Decisions

## D-001: 独り言閾値は app settings に置く

- 日付: 2026-04-02
- 理由: provider ごとに運用を変える要求は今のところなく、app 全体で十分なため

## D-002: settings 化するのは context-growth の 3 項目に限定する

- 日付: 2026-04-02
- 対象:
  - cooldown
  - 最小文字増分
  - 最小メッセージ増分
- 理由: ユーザーが体感している課題がこの 3 項目で説明でき、`session-start` 側を可変化する必要がないため
