# 20260404-session-density-tuning result

## 状態

- 完了

## 要約

- Session 専用の gap / padding / compact button / chip 高さを詰め、Full HD での圧迫感を density 側から下げた
- user bubble は avatar 分の左 gutter を持たず、message row 幅を使い切るようにした
- `docs/design/desktop-ui.md` と `docs/task-backlog.md` を current 方針へ同期した
- assistant message の `Details` icon は avatar 下へ移し、bubble 本文領域を削らない構成にした
- 実装コミットは `ba4b35f` `fix(session): refine rich text and density`
