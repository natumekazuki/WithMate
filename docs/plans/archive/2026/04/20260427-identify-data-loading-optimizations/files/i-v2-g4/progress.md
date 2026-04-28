# V2 runtime read-path / phase 4 Green

- [x] `src-electron/persistent-store-lifecycle-service.ts` の `SessionStorage`/`AuditLogStorage` を read interface 化。
- [x] `PersistentStoreBundle` の型を V1/V2 両 read ストレージに対応。
- [x] `APP_DATABASE_V2_FILENAME`（`withmate-v2.db`）判定で V2 DB を識別。
- [x] V2 判定時に `SessionStorageV2Read` / `AuditLogStorageV2Read` を選択。
- [x] V2 判定時に V1 `createSessionStorage` / `createAuditLogStorage` ファクトリーを呼ばない。
- [x] `main.ts` の session/audit log storage 参照型を read interface 化。
- [x] `main.ts` に write 用ガードを追加し、V2 read-only 時の書き込みを明示エラー化。
- [x] `main-session-persistence-facade.ts` の storage 型参照を read interface 化。
- [x] `src-electron/session-storage-v2-read.ts` の V2 read adapter を毎回 open/close する実装にし、ハンドル開放を伴う再生成シナリオを回避。
- [x] `scripts/tests/persistent-store-lifecycle-service.test.ts` の空配列比較を `deepEqual` へ修正し、V2 空一覧の期待値と一致させる。
- [x] 指定テスト + `npm run build:electron` を実行し green 確認。
