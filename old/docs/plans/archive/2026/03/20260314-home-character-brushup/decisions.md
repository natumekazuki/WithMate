# Decisions

## Summary
- Home の `Characters` は `Recent Sessions` と同じ toolbar パターンを使うが、表示要素は character 管理に必要な最小限へ留める。

## Decision Log

### 0001
- 日時: 2026-03-14
- 論点: Characters を独自レイアウトのまま調整するか、Recent Sessions と同じ設計パターンへ寄せるか
- 判断: 検索入力 + action button の toolbar と card 装飾は共通パターンに寄せる
- 理由: Home 内の一貫性を上げつつ、今後のブラッシュアップ軸も共有しやすくするため
- 影響範囲: HomeApp, styles, Home UI docs
