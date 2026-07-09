# Plan

- 作成日: 2026-03-28
- タスク: Session Open/Resume Bridge のリファクタ

## Goal

- `src-electron/main.ts` に残っている `Session Window` の生成・再利用・close/closed 制御を bridge service へ分離する
- `session start` と `session window close` に紐づく background hook を window bridge の責務として固定する
- TDD で window registry と close policy の振る舞いを先に固める

## Scope

- `src-electron/main.ts`
- 新しい session window bridge
- 関連 tests
- 必要な design doc / plan 更新

## Out Of Scope

- `createSession()` / `updateSession()` / `deleteSession()` の保存責務整理
- Memory orchestration の全面分離
- renderer 側の UI リファクタ

## Checks

1. `openSessionWindow()` の主要ロジックが bridge service に移る
2. window registry と close policy がテストで守られる
3. `main.ts` は BrowserWindow 生成と IPC 結線中心になる
