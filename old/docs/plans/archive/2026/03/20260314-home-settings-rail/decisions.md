# Decisions

## Summary

- `Settings` は浮遊 action にせず、`Characters` の上に専用 rail を切って配置する。

## Decision Log

### 0001

- 日時: 2026-03-14
- 論点: Home の `Settings` を画面右上へ重ね置きするか、右カラム内の専用領域へ置くか
- 判断: `Characters` パネルの上に `Settings` rail を置く
- 理由: 重なりで詰まって見えていたため。`Settings` は独立ヘッダーを維持するほどの情報量はないが、`Characters` の文脈の上に専用領域を切ると視線の競合を減らせる
- 影響範囲: `src/HomeApp.tsx`, `src/styles.css`, Home 関連 design docs
