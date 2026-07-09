# Decisions

- reflection backend は v1 では current coding provider を流用する
- trigger は `SessionStart` と `context-growth` の 2 系統に絞る
- `SessionStart` は monologue only、通常 reflection は `CharacterMemoryDelta + monologue`
- monologue は session `stream` に追記する
- right pane は既存の `独り言` host を流用し、stream の最新内容を表示する
