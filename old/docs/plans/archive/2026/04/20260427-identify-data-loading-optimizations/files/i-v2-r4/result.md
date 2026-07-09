# Result

- Slice: `i-v2-r4`
- Phase: `red`
- Scope: `scripts/tests` のみ（プロダクションコードは変更なし）

## 変更結果
- テスト追加: `scripts/tests/persistent-store-lifecycle-service.test.ts`
  - 2件の V2 red テストを追加。
  - 1件目: V2 DB に対して V1 `SessionStorage` を使うと `sessions` 読み出し時に `no such column: messages_json` で失敗することを再現。
  - 2件目: V2 DB 起動時に V1 factory が呼ばれず、`SessionStorageV2Read` と `AuditLogStorageV2Read` が返ることを期待（現状失敗）。

## 実行コマンド
- `npx tsx --test scripts/tests/persistent-store-lifecycle-service.test.ts`

## 失敗内容（想定どおり）
- 7件中2件失敗
  - `PersistentStoreLifecycleService は V2 DB では SessionStorageV2Read を使ってセッション要約を読む`
    - エラー: `no such column: messages_json`
  - `PersistentStoreLifecycleService は V2 DB では V1 write-capable storages を生成せず V2 read storages を返す`
    - 期待: V1 factory 呼び出しなし、インスタンスが V2 read storage

## 実装推奨（次フェーズ向け）
- `PersistentStoreLifecycleService` に V1/V2 判定を持たせ、V2 DB では
  - `SessionStorageV2Read` による起動時セッション要約読込
  - `AuditLogStorageV2Read` による監査ログ読込系の利用
  を選別する。
