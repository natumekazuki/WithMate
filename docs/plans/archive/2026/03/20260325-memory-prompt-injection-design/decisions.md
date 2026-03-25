# Decisions

- Memory の prompt 組み込み方針は `docs/design/memory-architecture.md` に集約する
- `Session Memory` は常設注入、`Repository Memory` は検索注入を基本とする
- `Character Memory` は常設ではなく必要時または薄い summary に留める
