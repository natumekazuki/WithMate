# Plan

- task: Memory extraction trigger を `outputTokens threshold` ベースで固定する
- owner: Codex
- status: in_progress

## Goal

- Memory extraction trigger の初期仕様を簡素に固定する
- provider ごとの 1 数値だけ Settings で扱う方針を docs に反映する

## Scope

- `docs/design/memory-architecture.md`
- `docs/design/settings-ui.md`
- `docs/task-backlog.md`

## Out Of Scope

- 実装
- trigger engine の細部
- 統計表示 UI

## Steps

1. trigger policy を `outputTokens threshold` ベースに置き換える
2. Settings に置く項目を最小形で定義する
3. backlog の次 slice を extraction trigger 実装前提に更新する
