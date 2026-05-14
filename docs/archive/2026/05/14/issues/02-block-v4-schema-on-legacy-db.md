# legacy DB に v4 schema を無条件注入しない

- Archived: 2026-05-14
- Resolution: Implemented in the SingleMate roadmap pass.

- Status: Archived
- Priority: P1
- Type: Bug / Data Integrity
- Related:
  - `src-electron/persistent-store-lifecycle-service.ts`
  - `src-electron/mate-storage.ts`
  - `src-electron/mate-embedding-cache.ts`
  - `src-electron/mate-growth-storage.ts`
  - `src-electron/mate-memory-storage.ts`
  - `src-electron/mate-profile-item-storage.ts`
  - `src-electron/mate-project-digest-storage.ts`
  - `src-electron/mate-semantic-embedding-storage.ts`
  - `src-electron/provider-instruction-target-storage.ts`

## Summary

現行コードでは active DB path が v1 / v2 / v3 file でも、Mate 系 storage が `CREATE_V4_SCHEMA_SQL` を実行しうる。  
結果として legacy DB file に v4 table 群が混在し、世代境界が壊れる。

## Current behavior

- `PersistentStoreLifecycleService.initialize()` は selected `dbPath` をそのまま `createMateStorage(dbPath, userDataPath)` へ渡す
- `MateStorage.initializeSchema()` は `CREATE_V4_SCHEMA_SQL` を無条件に実行する
- 同様に Mate 関連の複数 storage が `CREATE_V4_SCHEMA_SQL` を初期化時に実行している

## Problem

- `withmate.db` / `withmate-v2.db` / `withmate-v3.db` を開いただけで v4 table が追加されうる
- file 名と table 構成がずれ、障害調査や migration 条件分岐が難しくなる
- legacy DB を read / compatibility mode で扱うつもりでも、実際には write mutation が起きうる

## Proposed scope

- v4 schema を初期化してよい DB path を明示的に制限する
- legacy runtime / compatibility mode では Mate 系 write path を block または dedicated v4 DB へ分離する
- regression test で「legacy DB を開いても v4 table が増えない」ことを固定する

## Acceptance criteria

- [ ] `withmate.db` を開いても v4 table 群が増えない
- [ ] `withmate-v2.db` / `withmate-v3.db` を開いても v4 table 群が増えない
- [ ] v4 schema 初期化は canonical v4 path または明示 migration 完了後だけに限定される
- [ ] test で `sqlite_master` を確認し、cross-generation mutation を防ぐ

## Notes / open questions

- canonical v4 path を別 file にするなら、Mate 系 storage に渡す `dbPath` 自体を分ける必要がある
- 「legacy file に v4 table を追加する」方針を採るなら、その時点で file 名 / version metadata / docs の全面更新が必要


