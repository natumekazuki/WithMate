# runtime-selection-guard-alignment session plan

## Plan Tier

- tier: session plan
- reason: V2 DB 選択 guard の整合に限定され、想定変更は 2〜3 ファイルと既存テスト追加で 1 セッション完結見込み。ユーザー確認、複数段階、cross-repo、公開仕様変更、複数コミットはいずれも不要。
- questions.md: 不要。

## Goal

`resolveAppDatabasePath` と `PersistentStoreLifecycleService` の V2 判定を同じ意味に揃え、空または malformed な `withmate-v2.db` が直接 lifecycle に渡された場合でも V2 storage を選択しないようにする。

## Scope

- `withmate-v2.db` の名前だけではなく、必要な V2 tables が存在することを V2 runtime 選択の条件にする。
- V2 判定ロジックを共有可能な関数へ寄せ、`app-database-path.ts` と lifecycle の判定差分をなくす。
- lifecycle 直呼び出し時の malformed/empty V2 DB フォールバックをテストで固定する。

## Out of Scope

- V2 schema 自体の変更
- V1/V2 migration の追加
- V2 session write / audit write の追加実装
- UI 表示や docs/design の仕様更新

## Design Gate

- decision: workspace-only
- reason: 実装は内部 guard の整合であり、公開仕様・データモデル・ユーザー向け動作説明の変更ではないため。

## Affected Files

- `src-electron/app-database-path.ts`
- `src-electron/persistent-store-lifecycle-service.ts`
- `src-electron/database-schema-v2.ts`
- `scripts/tests/app-database-path.test.ts`
- `scripts/tests/persistent-store-lifecycle-service.test.ts`

## Slices

### 1. Red: lifecycle の不整合を失敗テストで固定

- 目的: basename が `withmate-v2.db` の空 DB を lifecycle に直接渡した場合、V2 storage を選ばない期待を先に追加する。
- 受入条件:
  - 空または required tables 不足の `withmate-v2.db` で `createSessionStorage` / `createAuditLogStorage` が呼ばれること。
  - 同条件で `SessionStorageV2Read` / `AuditLogStorageV2Read` が返らないこと。
  - 既存の有効 V2 DB テストは引き続き V2 storage を選ぶ期待のまま残ること。
- targeted tests:
  - `node --import tsx --test scripts/tests/persistent-store-lifecycle-service.test.ts`

### 2. Green: V2 判定を required tables semantics に統一

- 目的: lifecycle が `app-database-path.ts` と同じ validation semantics で V2 を選ぶようにする。
- 実装方針:
  - `REQUIRED_V2_TABLES` と V2 DB validation helper を共有できる形にする。
  - `resolveAppDatabasePath` は既存の「存在する有効 V2 を優先、そうでなければ V1」動作を維持する。
  - `PersistentStoreLifecycleService.initialize` は `withmate-v2.db` かつ required tables が揃う場合だけ V2 storage を選ぶ。
  - `recreate` の既存 V2 schema 作成動作は regression させない。
- targeted tests:
  - `node --import tsx --test scripts/tests/app-database-path.test.ts scripts/tests/persistent-store-lifecycle-service.test.ts`

### 3. Review: regression と docs 影響確認

- 目的: runtime selection guard の整合だけに変更が閉じていること、既存 V2 data loading 関連の保証を崩していないことを確認する。
- targeted tests:
  - `node --import tsx --test scripts/tests/session-storage-v2-read.test.ts scripts/tests/audit-log-storage-v2-read.test.ts scripts/tests/database-schema-v2.test.ts`
  - 必要に応じて `npm run build:electron`

## Status

- status: completed
- started: 2026-04-29
- completed: 2026-04-29

## Worklog

- 2026-04-29: サブエージェントで次タスクを調査し、V2 write path は実装済み、runtime selection guard 整合が次タスクとして妥当と判断した。
- 2026-04-29: session plan を作成した。Design Gate は workspace-only、質問なし。
- 2026-04-29: Red テストを追加し、`node --import tsx --test scripts/tests/persistent-store-lifecycle-service.test.ts` が `no such table: sessions` で期待どおり失敗することを確認した。
- 2026-04-29: Green 実装として V2 DB validation helper を共有し、lifecycle の V2 判定を required tables semantics に揃えた。
- 2026-04-29: Green 検証として `node --import tsx --test scripts/tests/app-database-path.test.ts scripts/tests/persistent-store-lifecycle-service.test.ts` が成功した。
- 2026-04-29: Review 検証として `node --import tsx --test scripts/tests/session-storage-v2-read.test.ts scripts/tests/audit-log-storage-v2-read.test.ts scripts/tests/database-schema-v2.test.ts` と `npm run build:electron` が成功した。
- 2026-04-29: サブエージェントレビューで指摘なし。Design Gate は workspace-only のままで妥当と確認した。
- 2026-04-29: 最終検証として `node --import tsx --test scripts/tests/app-database-path.test.ts scripts/tests/persistent-store-lifecycle-service.test.ts scripts/tests/session-storage-v2-read.test.ts scripts/tests/audit-log-storage-v2-read.test.ts scripts/tests/database-schema-v2.test.ts`、`npm run build:electron`、`git diff --check` が成功した。
- 2026-04-29: `npm run typecheck` は既存の広域 test 型エラーで失敗したため、今回の完了条件からは除外した。

## Completion Summary

- `isValidV2Database` と `REQUIRED_V2_TABLES` を V2 schema 近傍へ寄せ、`resolveAppDatabasePath` と `PersistentStoreLifecycleService` が同じ V2 判定 semantics を使うようにした。
- 空または required tables 不足の `withmate-v2.db` を lifecycle に直接渡した場合は、V2 storage ではなく injected V1-compatible storage を使う。
- `recreate` では `withmate-v2.db` の場合に schema 作成後に initialize するため、再生成後の V2 storage 選択は維持する。

## Validation Notes

- Red: `node --import tsx --test scripts/tests/persistent-store-lifecycle-service.test.ts` は expected failure。
- Green: `node --import tsx --test scripts/tests/app-database-path.test.ts scripts/tests/persistent-store-lifecycle-service.test.ts` は成功。
- Review: `node --import tsx --test scripts/tests/session-storage-v2-read.test.ts scripts/tests/audit-log-storage-v2-read.test.ts scripts/tests/database-schema-v2.test.ts` は成功。
- Review: `npm run build:electron` は成功。
- Review: `git diff --check` は成功。
- Final: `node --import tsx --test scripts/tests/app-database-path.test.ts scripts/tests/persistent-store-lifecycle-service.test.ts scripts/tests/session-storage-v2-read.test.ts scripts/tests/audit-log-storage-v2-read.test.ts scripts/tests/database-schema-v2.test.ts` は成功。
- Final: `npm run build:electron` は成功。
- Final: `git diff --check` は成功。
- Note: `npm run typecheck` は `scripts/tests/*` を中心とした既存の広域型エラーで失敗した。今回の runtime guard 差分の対象 validation は通過済み。

## Archive

- archive destination: `docs/plans/archive/2026/04/20260429-runtime-selection-guard-alignment/`
