# Decisions

## 2026-03-25

- `Session Copy` の UI は 1 行 1 候補の textarea とする
- 選択は render ごとの完全乱数ではなく、slot ごとの stable seed から決める
- 候補が 0 件なら bland default の 1 候補に fallback する
