# Decisions

## Summary

- まず Home の card 表現から theme rule を揃える
- 文字色は固定色ではなく、background の luminance から自動決定する

## Decision Log

### 0001

- 日時: 2026-03-15
- 論点: キャラカラーをどこから揃えるか
- 判断: Home の session card / character card を最初の適用先にする
- 理由: 一覧 UI は差分が見えやすく、`main / sub` の役割を最も整理しやすい
- 影響範囲: `src/HomeApp.tsx`, `src/styles.css`, `docs/design/desktop-ui.md`

### 0002

- 日時: 2026-03-15
- 論点: background と文字色の衝突をどう防ぐか
- 判断: `main` 色の relative luminance から前景色を自動決定する
- 理由: 色の自由度を落とさずに、Home / Character Editor / Session で同じルールを再利用できる
- 影響範囲: `src/ui-utils.tsx`, `src/HomeApp.tsx`, `src/styles.css`
