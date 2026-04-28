# planner-db-v2-design-retry1 統合サマリ

## Root Session が統合すべき成果物

disposable sandbox 側の提案実装:

- `.codex-disposable/planner-db-v2-design-retry1/repo/src-electron/database-schema-v2.ts`
- `.codex-disposable/planner-db-v2-design-retry1/repo/scripts/tests/database-schema-v2.test.ts`

task workspace 側の proposal:

- `docs/plans/20260427-identify-data-loading-optimizations/files/planner-db-v2-design-retry1/result.md`
- `docs/plans/20260427-identify-data-loading-optimizations/files/planner-db-v2-design-retry1/proposal/design.md`
- `docs/plans/20260427-identify-data-loading-optimizations/files/planner-db-v2-design-retry1/proposal/summary.md`

`proposal/questions.md` は作成していない。ユーザー確認が必要な未決事項はない。

## 変更概要

`src-electron/database-schema-v2.ts` の提案:

- `V2_SCHEMA_STATUS` を `ready-for-implementation` に変更。
- V2 DDL 定数を追加。
  - `CREATE_V2_APP_SETTINGS_TABLE_SQL`
  - `CREATE_V2_SESSIONS_TABLE_SQL`
  - `CREATE_V2_SESSION_MESSAGES_TABLE_SQL`
  - `CREATE_V2_AUDIT_LOGS_TABLE_SQL`
  - `CREATE_V2_AUDIT_LOG_DETAILS_TABLE_SQL`
  - `CREATE_V2_MODEL_CATALOG_TABLES_SQL`
  - `CREATE_V2_SCHEMA_SQL`
- API/query 用列定数を追加。
  - `V2_SESSION_SUMMARY_COLUMNS`
  - `V2_AUDIT_LOG_SUMMARY_COLUMNS`
- `sessions` から `messages_json` / `stream_json` を除外。
- `session_messages` を追加し、V1 `messages_json` の移行先にする。
- `audit_logs` から detail JSON 列を除外し、summary/list 用 columns に限定。
- `audit_log_details` を追加し、prompt/payload/operations/raw items/usage/assistant text の詳細取得先にする。
- MemoryGeneration / monologue / memory legacy tables は V2 schema に含めない。

`scripts/tests/database-schema-v2.test.ts` の提案:

- V2 DDL が SQLite で作成できることを検証。
- `withmate-v2.db` と `ready-for-implementation` を検証。
- `sessions` が `messages_json` / `stream_json` を持たないことを検証。
- `audit_logs` が detail JSON columns を持たず、`audit_log_details` に分離されることを検証。
- memory legacy tables と monologue table が作られないことを検証。

## Canonical Docs 反映候補

- `docs/design/database-v2-migration.md`
  - V2 DDL table list と migration mapping を確定内容へ更新。
  - `sessions.stream_json` を移行対象外にする理由を追記。
  - broken JSON は V2 raw 退避列に入れず migration report に記録する方針を追記。
- `docs/design/database-schema.md`
  - Current / Future Boundary を更新し、V2 `withmate-v2.db` の確定 schema を future/current transition として明記。
  - V1 memory legacy data は `withmate.db` に残ることを明記。
- `docs/design/data-loading-performance-audit.md`
  - Phase 3 の schema split を今回の V2 schema 名に合わせて更新。

## 実装順

1. `src-electron/database-schema-v2.ts` と `scripts/tests/database-schema-v2.test.ts` を repo 正本へ統合する。
2. `docs/design/database-v2-migration.md` と `docs/design/database-schema.md` を `proposal/design.md` に沿って更新する。
3. V1→V2 migration script の dry-run と write mode を実装する。
4. session storage を summary-first / message detail に分ける。
5. audit storage を summary list / detail fetch に分ける。
6. IPC / preload / renderer を lazy load に切り替える。

## 検証結果

disposable sandbox で次を実行済み。

```text
npx tsx --test scripts/tests/database-schema-v2.test.ts
```

結果:

- tests: 4
- pass: 4
- fail: 0

## Design Gate

- 推奨: repo-sync-required
- 理由: DB 正本 schema と migration 方針が canonical docs と実装の両方に影響する。
