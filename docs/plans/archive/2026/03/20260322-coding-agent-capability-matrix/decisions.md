# Decisions

## 2026-03-22

### cross-provider の正本表を別 doc として追加する

- `docs/design/codex-capability-matrix.md` だけでは provider 横断の比較表にならない
- 今後の task 管理では「この capability は Codex / Copilot / WithMate のどこまで進んだか」を同時に見たい
- そのため `docs/design/coding-agent-capability-matrix.md` を新規追加する

### provider native と wrapper current は列を分ける

- 同じ `対応済み` でも意味が違う
- provider native support と WithMate current 実装を同じ status で混ぜると、次 task の判断に使いにくい
- そのため provider 列と wrapper 列で status vocabulary を分ける

### この doc を今後の更新起点にする

- capability に関係する実装や改修では、この doc を同じ task で更新する
- 詳細は個別 doc に持ち、matrix は現状把握と優先順位付けの入り口にする
