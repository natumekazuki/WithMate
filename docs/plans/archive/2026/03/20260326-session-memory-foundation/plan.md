# Plan

- task: `#3` Session Memory の永続化基盤を実装する
- owner: Codex
- status: in_progress

## Goal

- `Session Memory v1` を SQLite に保存できるようにする
- session lifecycle と紐づけて、後続の extraction plane 実装を載せられる土台を作る

## Scope

- `src/app-state.ts`
- `src-electron/session-memory-storage.ts`
- `src-electron/main.ts`
- `docs/design/memory-architecture.md`
- `docs/design/electron-session-store.md`
- `scripts/tests/`

## Out Of Scope

- extraction model 実行
- Project Memory / Character Memory の保存
- Session UI への表示

## Steps

1. `SessionMemoryV1` の shared type / normalize / merge helper を追加する
2. SQLite-backed `session_memories` store を追加する
3. session create / update / run 後に memory metadata を同期する
4. storage test と docs を更新する
