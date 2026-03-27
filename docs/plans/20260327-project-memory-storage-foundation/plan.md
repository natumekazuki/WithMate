# Plan

- 作成日: 2026-03-27
- タスク: Project Memory の保存基盤を実装する

## Goal

- `project_scopes` と `project_memory_entries` を SQLite に追加する
- session の `workspacePath` から `git | directory` の project scope を解決できるようにする
- current session 群に対して scope を初期同期できるようにする

## Scope

- `src-electron/project-scope.ts`
- `src-electron/project-memory-storage.ts`
- `src-electron/main.ts`
- 必要な shared type と test
- 関連 design doc と DB 定義書

## Out Of Scope

- `Session -> Project` の昇格実装
- retrieval 実装
- renderer UI

## Checks

1. app 起動時に `project_scopes` と `project_memory_entries` が作成される
2. 既存 session の `workspacePath` から scope を解決して同期できる
3. Git 管理か否かで `projectType` が切り替わる
4. tests と docs が current 実装へ同期している
