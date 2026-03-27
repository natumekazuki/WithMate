# Decisions

## D-001 separate table にする

- `Character Memory` は `Project Memory` と分けて `character_scopes` / `character_memory_entries` を持つ
- relation 記憶は作業知識と混ぜない

## D-002 v1 は保存基盤だけ入れる

- reflection 実行や monologue 実行は今回の scope に入れない
- まずは永続化と reset を先に成立させる
