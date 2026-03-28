# Plan

- 作成日: 2026-03-28
- タスク: Session Bulk Persistence のリファクタ

## Goal

- `replaceAllSessions()` と migration / rollback / reset に残っている session write path を `SessionPersistenceService` に寄せる
- session 一括置換時の telemetry / background activity / provider thread invalidation を service 境界にまとめる
- TDD で bulk replace の副作用を先に固定する

## Scope

- `src-electron/main.ts`
- `src-electron/session-persistence-service.ts`
- 関連 tests
- 必要な design doc / plan 更新

## Out Of Scope

- character 同期の service 化
- Memory orchestration の service 分離
- UI 側の変更

## Checks

1. `replaceAllSessions()` が `SessionPersistenceService` に移る
2. model catalog import / rollback / settings 変更時の session bulk 更新が service 経由になる
3. bulk replace 時の副作用がテストで守られる
