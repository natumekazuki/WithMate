# Plan

- 作成日: 2026-03-28
- タスク: Settings reset/export 経路のリファクタ

## Goal

- `main.ts` に残っている settings / catalog 系の reset / export write path を service に集約する
- `DB を初期化` と `model catalog export` の境界を `SettingsCatalogService` に寄せる
- `main.ts` の settings / catalog 責務をさらに薄くする

## Scope

- `src-electron/main.ts`
- `src-electron/settings-catalog-service.ts`
- 関連 tests
- 必要な docs / plan 更新

## Out Of Scope

- reset UI の文言変更
- DB schema の変更

## Checks

1. `resetAppDatabase()` の主要処理が service に寄る
2. `model catalog export` の read path が service に寄る
3. reset / export の主要経路がテストで守られる
