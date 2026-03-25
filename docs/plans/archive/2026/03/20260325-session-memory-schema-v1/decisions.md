# Decisions

- `Session Memory v1` は最小 schema で始める
- ただし `schemaVersion` を持たせて後方拡張を前提にする
- top-level field は骨格だけに絞り、詳細は後から追加する
