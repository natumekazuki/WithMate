# V1→V2 migration write mode（mig-green）結果

- Slice / フェーズ: `mig-green` / `green`
- TDDモード: `green`

## 変更ファイル
- `.codex-disposable/mig-green/repo/scripts/migrate-database-v1-to-v2.ts`
- `docs/plans/20260427-identify-data-loading-optimizations/files/mig-green/proposal/design.md`
- `docs/plans/20260427-identify-data-loading-optimizations/files/mig-green/proposal/summary.md`
- `docs/plans/20260427-identify-data-loading-optimizations/files/mig-green/result.md`

## 実装概要
- `scripts/migrate-database-v1-to-v2.ts` に `createMigrationWriteReport({ v1DbPath, v2DbPath, overwrite? })` を export。
- V1 を read-only 扱いで開き、V2 を `CREATE_V2_SCHEMA_SQL` で作成。
- `overwrite` 未指定時に V2 が既存なら throw、`overwrite: true` のとき既存を置換。
- write 処理は単一トランザクション（`BEGIN IMMEDIATE` / `COMMIT`）で実行。
- sessions の header copy、`session_messages`/`session_message_artifacts`、`audit_logs`/`audit_log_details`/`audit_log_operations` を要件どおり移行。
- legacy app setting のキー除外、memory legacy tables の未コピー。
- JSON 破損は dry-run と同様の issue 記録を行い、該当 payload は保護的にスキップ。
- CLI は dry-run を維持しつつ `--write --v1 <path> --v2 <path> [--overwrite]` を追加。

## テスト実行
- `npx tsx --test .\\.codex-disposable\\mig-green\\repo\\scripts\\tests\\database-v1-to-v2-migration.test.ts`
- `npx tsx --test .\\.codex-disposable\\mig-green\\repo\\scripts\\tests\\database-v1-to-v2-migration.test.ts .\\.codex-disposable\\mig-green\\repo\\scripts\\tests\\database-schema-v2.test.ts`

## docs/test 更新
- 正本 docs は更新せず、必要メモを `docs/plans/20260427-identify-data-loading-optimizations/files/mig-green/proposal/design.md` に追加。
- `scripts/tests/database-v1-to-v2-migration.test.ts` は変更せず、既存テストを green で通過。

## 残リスク
- `createMigrationWriteReport` の戻りレポート項目（`input`/`migratedV2Counts` 構造）は公開仕様として確定していないため、将来の API 追加仕様と差異が出る可能性。
- `usage_json` の数値型キーが欠損/非数値の場合は `null` へ吸収しているため、厳密バリデーション要件が強化された場合は調整余地がある。
