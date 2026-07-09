# Decisions

## D-001 background activity は専用 live state を持つ

- `audit_logs` だけを poll して右ペインを更新しない
- main process で `memory-generation / monologue` の session background activity state を持ち、IPC event で流す

## D-002 monologue は host だけ先に置く

- current milestone では monologue 実行系は未実装
- `独り言` 面は empty state のみとする

## D-003 auto switch は running を基準にする

- `Latest Command` は session run 中を最優先で表示する
- `Memory生成` と `独り言` は対応 state が `running` の時だけ自動切り替えする
