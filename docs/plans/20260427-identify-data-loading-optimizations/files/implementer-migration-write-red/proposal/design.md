# implementer-migration-write-red

- スライスID: `implementer-migration-write-red`
- TDDフェーズ: `red`
- 実装モード: `tests only`（本実装は追加していない）

## 変更ファイル
- `scripts/tests/database-v1-to-v2-migration.test.ts`
- `docs/plans/20260427-identify-data-loading-optimizations/files/implementer-migration-write-red/proposal/design.md`
- `docs/plans/20260427-identify-data-loading-optimizations/files/implementer-migration-write-red/proposal/summary.md`
- `docs/plans/20260427-identify-data-loading-optimizations/files/implementer-migration-write-red/result.md`

## 実装内容
- `scripts/tests/database-v1-to-v2-migration.test.ts` に write mode 向け red テストを追加。
- `createMigrationWriteReport({ v1DbPath, v2DbPath, overwrite? })` を想定し、V1 fixture を使って V2 への write 挙動を検証する期待断言を追加。
- 既存 dry-run テストの前提となる fixture 生成関数を `dirPath` 付きに拡張。
- 書き込み後に確認する項目として、V2 スキーマ作成、sessions header コピーと件数、session_messages の展開、artifact の分離、audit summary/detail/operation の分離、legacy 設定/legacy table 非移行、V1 sessions 件数不変を追加。

## 未実装範囲
- `createMigrationWriteReport` 本体は本スライスでは実装していない。
- `scripts/migrate-database-v1-to-v2.ts` と `src-electron/database-schema-v1.ts` / `src-electron/database-schema-v2.ts` は本スライスで編集していない。

## 進捗リスク
- `createMigrationWriteReport` が未実装のため、追加したテストは呼び出し時点で失敗する。
- 次フェーズ（green）で実装時に、期待する seq の起点や artifact JSON 形状を一致させる必要あり。
