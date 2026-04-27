# V2 runtime read-path / phase 4 Green 実装要約

- 対象: V2 runtime read-path, Green
- 実装:
  - `PersistentStoreLifecycleService` を V2 判定時に `SessionStorageV2Read` と `AuditLogStorageV2Read` を用いる構成に変更。
  - `SessionStorageRead` / `SessionStorageWrite`、`AuditLogStorageRead` / `AuditLogStorageWrite` 型を導入。
  - V2 DB 判定は `APP_DATABASE_V2_FILENAME`（`withmate-v2.db`）一致で行う。
  - `main.ts` で session/auditLog storage を read 型として保持し、書き込みは type guard + 明示エラーで保護。
  - `main-session-persistence-facade.ts` の `getSessionStorage` 型を read interface に合わせて更新。
  - `SessionStorageV2Read` / `AuditLogStorageV2Read` はクエリ実行ごとに DB オープンを開放する形へ揃え、`recreateDatabaseFile` 前提の close race を低減。
  - ライフサイクル green 切替検証として `scripts/tests/persistent-store-lifecycle-service.test.ts` を更新し、V2 空一覧ケースを通す調整を追加（`deepEqual`）。
