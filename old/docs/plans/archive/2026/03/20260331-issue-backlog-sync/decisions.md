# 決定

## 2026-03-31

- `docs/task-backlog.md` は今回も curated backlog として扱い、GitHub issue の state をそのまま `実装状況` へ転記しない
- CLOSED の `#2` `#6` `#8` `#9` は、今回の backlog が「いま追うべき残タスク」の管理文書である前提を維持するため追加しない
- `#32` は `#24` と同じ session resume / provider thread 管理クラスタの不具合として扱い、日常利用を止める性質が強いため `P1` で `#24` 近辺へ置く
- `#31` は `#3` 前提の Memory 運用 / 観測 UI と判断し、`#22` 周辺へ置く。`docs/design/character-memory-storage.md` の Non Goal を踏まえ、まず閲覧 / 削除中心の slice を想定する
- `#33` は approval UI の再実装ではなく provider capability / SDK 追従 task と判断し、`#10` `#17` と同じクラスタへ置く
- `#30` は Session UI 密度改善の一部として `#20` `#19` 近辺へ置き、`docs/design/desktop-ui.md` の Action Dock 仕様へ寄せるメモを付ける
- 参照元には今回の分類根拠として `docs/design/provider-adapter.md` と `docs/design/character-memory-storage.md` を追加する
