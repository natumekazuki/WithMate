# Decisions

## Summary

- Session 実行中の会話本文と command 実況は、同一 pending bubble に詰め込まず別面へ分離する

## Decision Log

### 0001

- 日時: 2026-03-22
- 論点: `assistantText` と `live run step` を同じ pending bubble に置き続けるか
- 判断: `assistantText` は message list、`live run step` は composer 直上の `Activity Monitor` に分離する
- 理由: command の可視性を維持しながら、chat 本文が長い step list に押し流される問題を避けたいため
- 影響範囲: `docs/design/session-live-activity-monitor.md`, `docs/design/desktop-ui.md`

### 0002

- 日時: 2026-03-22
- 論点: `Activity Monitor` を side pane にするか bottom dock にするか
- 判断: initial design は composer 直上の bottom dock にする
- 理由: Session Window の幅に依存せず、desktop / narrow width の両方で同じ mental model を保ちやすいため
- 影響範囲: `docs/design/session-live-activity-monitor.md`

### 0003

- 日時: 2026-03-22
- 論点: `Activity Monitor` と message list の scroll を共有するか
- 判断: follow / scroll は完全に独立させる
- 理由: 「chat を読み返す」と「最新 command を監視する」は別行為であり、同一スクロールに縛ると片方が必ず犠牲になるため
- 影響範囲: `docs/design/session-live-activity-monitor.md`, `docs/design/desktop-ui.md`
