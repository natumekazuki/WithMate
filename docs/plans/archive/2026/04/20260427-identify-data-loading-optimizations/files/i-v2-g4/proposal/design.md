# V2 read-path 切替設計

- 判定条件: DB パスの basename が `withmate-v2.db` の場合を V2 DB とする。
- 初期化時 (`PersistentStoreLifecycleService#initialize`) に V2 判定を行い、`SessionStorageV2Read` と `AuditLogStorageV2Read` を直接構成。
- V1 の write-capable ファクトリー (`createSessionStorage`, `createAuditLogStorage`) は V1 DB のみ呼び出し。
- `PersistentStoreBundle` のストレージ型は read-only interface を公開し、main 側で必要時のみ write-capable と見なすガードを実施。
- V2 DB では `main.ts` 内で以下を明示エラーとして扱う:
  - `SessionStorage` の `upsertSession` / `replaceSessions` / `deleteSession` / `clearSessions`
  - `AuditLogStorage` の `createAuditLog` / `updateAuditLog` / `clearAuditLogs`
