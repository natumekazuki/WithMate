# Progress

- `scripts/tests/persistent-store-lifecycle-service.test.ts` に V2 runtime red テストを追加（V1 写し替えなしで壊れるケースを明示）。
- 追加した検証観点
  - V2 DB (`withmate-v2.db` 名称想定) で V1 `SessionStorage` を使うと `SessionStorage.listSessions` が起動時エラーになること。
  - V2 DB 起動時に V1 の `createSessionStorage` / `createAuditLogStorage` が呼び出されない前提を明文化。
  - V2 起動時に `SessionStorageV2Read` / `AuditLogStorageV2Read` が返ることを期待。
- 次ステップ: 本番コードに対して同等の red -> green 対応を実装する。
