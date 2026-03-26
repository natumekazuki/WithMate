# Decisions

- 今回は `Session Memory` だけを実装し、`Project` と `Character` は docs 上の設計に留める
- `session_memories` は `sessions.id` を foreign key に持つ別 table とする
- session 作成時は `taskTitle` を初期 `goal` として default memory を作る
- `updatedAt` は memory 内容更新の時刻として扱い、session metadata 同期だけでは無理に更新しない
