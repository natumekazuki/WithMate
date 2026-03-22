# Decisions

## 2026-03-22

### capability 単位で follow-up task を切る

- Copilot 対応は範囲が広い
- adapter、UI、audit、skill、slash command を 1 task にまとめると追跡不能になる
- そのため `coding-agent-capability-matrix.md` の行を基準に、1 capability ずつ潰す

### 最初は Session UI の最低限動作を優先する

- 先に provider-specific extension へ行くより、`run / stream / cancel / audit` の最小実用線を作る方が価値が高い
- Milestone A は「Codex と同じ Session UI で Copilot が最低限動く」ことを基準に置く

### `未確認` capability は実装前に小さく調査する

- Copilot 側は docs だけでは確定しない項目がまだ多い
- `未確認` のまま実装 plan を切ると手戻りが大きい
- そのため実装前に short research task を挟める前提にする
