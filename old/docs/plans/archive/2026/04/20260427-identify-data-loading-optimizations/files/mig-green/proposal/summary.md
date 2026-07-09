# Proposal Summary (mig-green / green)

- slice: `mig-green`
- phase: `green`
- tdd mode: `green`

## 変更ファイル
- `.codex-disposable/mig-green/repo/scripts/migrate-database-v1-to-v2.ts`
- `docs/plans/20260427-identify-data-loading-optimizations/files/mig-green/proposal/design.md`
- `docs/plans/20260427-identify-data-loading-optimizations/files/mig-green/result.md`
- `docs/plans/20260427-identify-data-loading-optimizations/files/mig-green/proposal/summary.md`

## 実装要点
- `createMigrationWriteReport` を実装し、V1 read-only から V2 write を追加。
- `CREATE_V2_SCHEMA_SQL` で V2 を作成。
- `--write` CLI を追加（`--v1`, `--v2`, `--overwrite`）。
- `overwrite` 未指定時に V2 既存ファイルがあると throw。
- トランザクション内で sessions/messages/artifacts/audit を整合的に保存。
- legacy app settings と memory 由来の legacy tables は write で除外。
- 破損 JSON は issue に集約し、対象 payload はスキップ。

## 検証
- `npx tsx --test .\\.codex-disposable\\mig-green\\repo\\scripts\\tests\\database-v1-to-v2-migration.test.ts`
- `npx tsx --test .\\.codex-disposable\\mig-green\\repo\\scripts\\tests\\database-v1-to-v2-migration.test.ts .\\.codex-disposable\\mig-green\\repo\\scripts\\tests\\database-schema-v2.test.ts`
