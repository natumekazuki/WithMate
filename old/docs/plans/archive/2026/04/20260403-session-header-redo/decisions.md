# Decisions

## Decision 1

- status: decided
- decision: header は「collapsed title handle を右ペインに置き、必要時だけ full-width header を出す」2 段構成にする
- rationale:
  - 左列の `message list + Action Dock` を通常時に最上端から使い切りたい
  - 右列には title と context pane の関係を保ちたい
  - 操作ボタンは `More` へ隠さず、expanded state で一度に押せる方が user 意図に合う

## Decision 2

- status: decided
- decision: `Audit Log / Terminal` は expanded header 側へ戻し、right pane 上部には `Generate Memory` だけを残す
- rationale:
  - 今回の意図は「右ペインは title handle + monitor 領域」であり、session window 全体の操作は expanded header に集める方が自然
  - `Generate Memory` は right pane の monitor 行動として残す

## Decision 3

- status: decided
- decision: `docs/design/desktop-ui.md` と `docs/manual-test-checklist.md` と `docs/task-backlog.md` を同期し、`.ai_context/` と `README.md` は更新しない
- rationale:
  - 今回は Session Window の局所 UI 変更であり、公開仕様やアーキテクチャ境界は変えていない
  - `.ai_context/` や `README.md` に反映すべき新しい全体ルールは増えていない
