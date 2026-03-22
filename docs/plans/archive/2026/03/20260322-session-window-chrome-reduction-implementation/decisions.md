# Decisions

## 2026-03-22

- `header` は完全非表示にはせず、常時 1 行の `Top Bar` を残す
- `Rename / Delete` は `Top Bar` の expand 時だけ表示し、通常時は title と global action を主役にする
- `Action Dock` は manual toggle を持つ compact / expanded の 2 状態にする
- `Action Dock` は skill picker / path picker / retry conflict / validation error がある間は expanded を維持する
- SessionWindow の外側 `panel` chrome は減らすが、`Latest Command` と composer 内部 card は残して情報の境界を維持する
