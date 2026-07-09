# Decisions

- 原因は renderer の初期化順で、`retryBanner` の `useMemo` が `pendingIndicatorCharacterName` を TDZ 状態で参照していたこと
- 修正は依存関係どおりに派生 state の定義順を入れ替える最小変更に留める
