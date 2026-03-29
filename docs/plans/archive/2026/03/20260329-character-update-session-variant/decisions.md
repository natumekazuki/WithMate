# 決定事項

## 2026-03-29

- `character-update` は専用の中間 window ではなく、`SessionWindow` の UI variant として扱う
- Character Editor の `Open Update Workspace` は provider picker modal を開き、選択後に update session を直接起動する
- `character-update` session の右ペインは `LatestCommand / MemoryExtract` を表示する
- `character-update` session では header の `Terminal` と `More` を出さない
