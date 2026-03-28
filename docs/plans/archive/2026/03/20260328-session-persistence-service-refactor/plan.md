# Plan

- 作成日: 2026-03-28
- タスク: Session Persistence Service のリファクタ

## Goal

- `src-electron/main.ts` に残っている `createSession / updateSession / deleteSession / upsertSession` の保存責務を service へ分離する
- provider/model 解決と session 関連の副作用同期を `Session` ドメインの service にまとめる
- TDD で作成・更新・削除時の副作用を先に固定する

## Scope

- `src-electron/main.ts`
- 新しい session persistence service
- 関連 tests
- 必要な design doc / plan 更新

## Out Of Scope

- `replaceAllSessions()` の全面移行
- Memory orchestration の service 分離
- renderer 側の session UI リファクタ

## Checks

1. `createSession / updateSession / deleteSession / upsertSession` が service 経由になる
2. provider/model 解決、allowedAdditionalDirectories 正規化、memory/scope 同期が service に集約される
3. 作成・更新・削除の副作用がテストで守られる
