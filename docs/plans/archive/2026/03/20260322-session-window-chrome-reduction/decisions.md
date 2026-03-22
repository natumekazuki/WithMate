# Decisions

## Summary

- SessionWindow の次フェーズは `chrome reduction` とし、機能追加ではなく viewport 拡張を主題にする
- `header` は薄い `Top Bar` へ落とし、collapse 可能にする方向で設計する
- `Action Dock` は `compact / expanded` の 2 状態を持つ方向で設計する
- `message list + right pane` を包む外側 card は撤去候補とし、`Work Surface` をより flush に使う
- `Latest Command` の責務は維持し、今回の target design では right pane の data mapping は変えない
- 今回は docs only で止め、実装は follow-up とする
