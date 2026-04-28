# planner-db-v2-design-retry1 結果

## Plan Tier Judgment

- 判定: repo plan 配下の proposal 作成
- 理由: V2 DB schema、V1→V2 migration、canonical design doc 反映、schema test 追加案を含むため repo plan 相当。ただし本作業では repo 正本を編集せず、指定された task workspace と disposable sandbox のみへ成果物を置いた。

## Goal

`docs/design/data-loading-performance-audit.md` の構造改革に着手できるよう、V2 DB schema と V1→V2 migration 方針を `src-electron/database-schema-v2.ts` へ実装可能な粒度まで確定する。

## Scope

- 対象: V2 新規 DB `withmate-v2.db`
- 対象 schema: `app_settings`、`sessions`、`session_messages`、`audit_logs`、`audit_log_details`、`model_catalog_*`
- 除外: `session_memories`、`project_scopes`、`project_memory_entries`、`character_scopes`、`character_memory_entries`、MemoryGeneration、monologue、`sessions.stream_json`
- migration: 通常起動では実行せず、別 migration script が V1 `withmate.db` を read-only 入力として V2 を作る

## 確定した V2 DB 設計

### DB 名と schema source

- V2 DB filename: `withmate-v2.db`
- V2 schema source: `src-electron/database-schema-v2.ts`
- V2 schema status: `ready-for-implementation`
- V1 schema source: `src-electron/database-schema-v1.ts`
- V1 DB は legacy data として保持し、通常起動で破壊しない。

### `sessions`

`sessions` は一覧・復元判定・軽量検索に必要な header のみを持つ。V1 の `messages_json` / `stream_json` は持たない。

主要列:

- `id TEXT PRIMARY KEY`
- `task_title TEXT NOT NULL`
- `task_summary TEXT NOT NULL`
- `status TEXT NOT NULL`
- `updated_at TEXT NOT NULL`
- `provider TEXT NOT NULL`
- `catalog_revision INTEGER NOT NULL DEFAULT 1`
- `workspace_label TEXT NOT NULL`
- `workspace_path TEXT NOT NULL`
- `branch TEXT NOT NULL`
- `session_kind TEXT NOT NULL DEFAULT 'default'`
- `character_id TEXT NOT NULL`
- `character_name TEXT NOT NULL`
- `character_icon_path TEXT NOT NULL`
- `character_theme_main TEXT NOT NULL DEFAULT '#6f8cff'`
- `character_theme_sub TEXT NOT NULL DEFAULT '#6fb8c7'`
- `run_state TEXT NOT NULL`
- `approval_mode TEXT NOT NULL`
- `codex_sandbox_mode TEXT NOT NULL`
- `model TEXT NOT NULL`
- `reasoning_effort TEXT NOT NULL`
- `custom_agent_name TEXT NOT NULL DEFAULT ''`
- `allowed_additional_directories_json TEXT NOT NULL DEFAULT '[]'`
- `thread_id TEXT NOT NULL DEFAULT ''`
- `message_count INTEGER NOT NULL DEFAULT 0`
- `audit_log_count INTEGER NOT NULL DEFAULT 0`
- `last_active_at INTEGER NOT NULL`

Index:

- `idx_v2_sessions_last_active ON sessions(last_active_at DESC, id DESC)`
- `idx_v2_sessions_workspace ON sessions(workspace_path, last_active_at DESC)`
- `idx_v2_sessions_character ON sessions(character_id, last_active_at DESC)`

### `session_messages`

`session_messages` は V1 `sessions.messages_json` を 1 message = 1 row に展開する。session 一覧では読まない。

主要列:

- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE`
- `seq INTEGER NOT NULL`
- `role TEXT NOT NULL CHECK (role IN ('user', 'assistant'))`
- `text TEXT NOT NULL DEFAULT ''`
- `accent INTEGER NOT NULL DEFAULT 0`
- `artifact_json TEXT NOT NULL DEFAULT ''`
- `created_at TEXT NOT NULL DEFAULT ''`
- `UNIQUE(session_id, seq)`

Index:

- `idx_v2_session_messages_session_seq ON session_messages(session_id, seq)`
- `idx_v2_session_messages_session_id_desc ON session_messages(session_id, id DESC)`

### `audit_logs`

`audit_logs` は一覧用 summary だけを持つ。`listSessionAuditLogs()` 相当の V2 API は `limit` / cursor 前提でこの table のみを読む。

主要列:

- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE`
- `created_at TEXT NOT NULL`
- `phase TEXT NOT NULL`
- `provider TEXT NOT NULL`
- `model TEXT NOT NULL`
- `reasoning_effort TEXT NOT NULL`
- `approval_mode TEXT NOT NULL`
- `thread_id TEXT NOT NULL DEFAULT ''`
- `assistant_text_preview TEXT NOT NULL DEFAULT ''`
- `operation_count INTEGER NOT NULL DEFAULT 0`
- `raw_item_count INTEGER NOT NULL DEFAULT 0`
- `input_tokens INTEGER`
- `cached_input_tokens INTEGER`
- `output_tokens INTEGER`
- `has_error INTEGER NOT NULL DEFAULT 0`
- `error_message TEXT NOT NULL DEFAULT ''`
- `detail_available INTEGER NOT NULL DEFAULT 1`

Index:

- `idx_v2_audit_logs_session_id_desc ON audit_logs(session_id, id DESC)`
- `idx_v2_audit_logs_session_created ON audit_logs(session_id, created_at DESC, id DESC)`
- `idx_v2_audit_logs_phase ON audit_logs(session_id, phase, id DESC)`

### `audit_log_details`

`audit_log_details` は監査ログ詳細表示時だけ読む payload table とする。

主要列:

- `audit_log_id INTEGER PRIMARY KEY REFERENCES audit_logs(id) ON DELETE CASCADE`
- `logical_prompt_json TEXT NOT NULL DEFAULT '{}'`
- `transport_payload_json TEXT NOT NULL DEFAULT ''`
- `assistant_text TEXT NOT NULL DEFAULT ''`
- `operations_json TEXT NOT NULL DEFAULT '[]'`
- `raw_items_json TEXT NOT NULL DEFAULT '[]'`
- `usage_json TEXT NOT NULL DEFAULT ''`

### `app_settings` / `model_catalog_*`

MemoryGeneration / Character Reflection 用 legacy setting key は migration 対象外だが、app 設定と model catalog の保存構造自体は V2 に残す。

- `app_settings`
- `model_catalog_revisions`
- `model_catalog_providers`
- `model_catalog_models`

### 除外する legacy 領域

V2 正本 schema には次を含めない。

- `session_memories`
- `project_scopes`
- `project_memory_entries`
- `character_scopes`
- `character_memory_entries`
- MemoryGeneration
- monologue
- `sessions.stream_json`

`sessions.stream_json` は current runtime で新規利用しない独り言 legacy 表現であり、data loading optimization の目的に対して一覧・詳細の正本データではない。既存実データは V1 DB に残るため、V2 migration では移行対象外とする。

## V1→V2 Migration 方針

### Copy

- `sessions` header 列は V2 `sessions` へコピーする。
- `app_settings` は legacy MemoryGeneration / Character Reflection key を除外してコピーする。
- `model_catalog_*` は revision 整合を保ってコピーする。

### Transform

- `sessions.messages_json` は JSON 配列として parse し、配列 index を `seq` として `session_messages` へ insert する。
- message `role` は `user` / `assistant` 以外を skip し、migration report に記録する。
- message `text` は文字列でない場合は `''` に normalize する。
- message `accent` は boolean を `0/1` へ変換する。
- message `artifact` は存在する場合だけ `artifact_json` に JSON 文字列として保存する。
- `audit_logs` の metadata は V2 `audit_logs` へ insert する。
- `audit_logs.assistant_text` は `assistant_text_preview` に短縮して保存し、全文は `audit_log_details.assistant_text` に保存する。
- `operations_json` の配列長を `operation_count` に保存する。
- `raw_items_json` の配列長を `raw_item_count` に保存する。
- `usage_json` から `inputTokens` / `cachedInputTokens` / `outputTokens` を列へ展開する。
- `logical_prompt_json` / `transport_payload_json` / `operations_json` / `raw_items_json` / `usage_json` は `audit_log_details` に移す。

### Skip

- `sessions.stream_json`
- `session_memories`
- `project_scopes`
- `project_memory_entries`
- `character_scopes`
- `character_memory_entries`
- MemoryGeneration / Character Reflection 用 setting key
- background memory / monologue 用の legacy data

Skip した件数と理由は migration report に記録する。V1 DB は削除しないため、legacy data は `withmate.db` 側に残る。

### Broken JSON

V1 の broken JSON は V2 本体へ raw 退避列を増やさない。対象 row を skip し、session id / audit log id / column / error を migration report に記録する。V2 正本 schema を壊れた legacy payload の保管庫にしないため。

## 実装順

1. `src-electron/database-schema-v2.ts` に V2 DDL 定数と一覧列定数を導入する。
2. `scripts/tests/database-schema-v2.test.ts` を追加し、SQLite 上で schema 作成、legacy table/column 不在、summary/detail 分離を検証する。
3. V2 DB open helper を追加し、通常起動は V2 DB が存在する場合だけ V2 を正本として開く。
4. V1→V2 migration script を追加し、dry-run、transaction、report、skip 記録を実装する。
5. `src-electron/session-storage.ts` を V2 用に分離し、summary list と message detail 取得 API を分ける。
6. `src-electron/audit-log-storage.ts` を V2 用に分離し、audit summary list と detail 取得 API を分ける。
7. IPC / preload / renderer を summary-first と detail lazy load に切り替える。
8. `docs/design/database-v2-migration.md` と `docs/design/database-schema.md` に V2 確定 schema を反映する。

## Slice List

| Slice | Purpose | Dependencies | Acceptance Criteria | Targeted Tests | TDD Mode |
| --- | --- | --- | --- | --- | --- |
| 1. V2 schema constants | DDL と API 用列定数を固定する | なし | `withmate-v2.db` 用 table が作成でき、legacy memory/monologue が含まれない | `scripts/tests/database-schema-v2.test.ts` | test-first 可 |
| 2. Migration dry-run | V1 入力の件数・skip・推定 payload を確認する | Slice 1 | V1 を変更せず report を出せる | migration dry-run unit test | test-first |
| 3. Migration write | V2 DB 作成と transform を transaction で実行する | Slice 2 | sessions/messages/audit summaries/details の件数が一致する | fixture migration test | test-first |
| 4. Session storage V2 | `listSessionSummaries()` と detail hydrate を分ける | Slice 1 | 一覧 query が `session_messages` を読まない | storage query/behavior test | test-first |
| 5. Audit storage V2 | audit summary list と detail fetch を分ける | Slice 1 | list は limit/cursor で detail JSON を読まない | storage pagination test | test-first |
| 6. UI/API integration | renderer を summary-first にする | Slice 4, 5 | 起動・session 切替で巨大 JSON を読まない | IPC/preload/UI projection test | test-after 可 |

## Affected Files

提案実装済み:

- `src-electron/database-schema-v2.ts`
- `scripts/tests/database-schema-v2.test.ts`

root session 統合時に更新候補:

- `docs/design/database-v2-migration.md`
- `docs/design/database-schema.md`
- `docs/design/data-loading-performance-audit.md`
- `src-electron/database-schema-v2.ts`
- `scripts/tests/database-schema-v2.test.ts`
- `src-electron/session-storage.ts`
- `src-electron/audit-log-storage.ts`
- `src-electron/sqlite-connection.ts`
- `src-electron/main-ipc-deps.ts`
- `src-electron/main-ipc-registration.ts`
- `src-electron/preload-api.ts`
- `src/withmate-window-api.ts`
- `src/session-state.ts`
- `src/app-state.ts`

## 未解決事項

- ユーザー確認が必要な未解決事項: なし
- `proposal/questions.md`: 作成なし

## TDD 例外

- 例外なし。
- DB schema は `scripts/tests/database-schema-v2.test.ts` で先に固定できる。
- renderer の段階読み込み UI は既存 UI の結合度が高いため、最小の projection/IPC test を先に置き、不足分は implementation 後の回帰 test で補う。

## Design Gate Recommendation

- 判定: repo-sync-required
- 理由: V2 DB 正本 schema、V1→V2 migration、legacy memory/monologue 除外方針は canonical design doc と実装の同期が必要。`docs/design/database-v2-migration.md` と `docs/design/database-schema.md` の更新対象。

## Risks

- V1 broken JSON を skip するため、migration report の粒度が不足するとユーザーが欠損を追跡しづらい。
- `audit_log_count` / `message_count` は denormalized counter なので、V2 storage 実装で transaction 内更新を徹底する必要がある。
- `assistant_text_preview` の切り詰め長を実装で固定する必要がある。設計上は 500 文字程度を推奨する。
- `app_settings` の legacy key 除外は migration script 側の allowlist で実装しないと混入しやすい。

## Validation Strategy

- `npx tsx --test scripts/tests/database-schema-v2.test.ts`
- migration fixture test で V1 `messages_json` から `session_messages` への展開を検証する。
- migration fixture test で V1 `audit_logs` から summary/detail 分離を検証する。
- broken JSON fixture test で V2 DB に raw legacy 退避列を増やさず report へ出ることを検証する。
- storage test で `listSessionSummaries()` が message/detail table を読まずに返ることを検証する。
- audit storage test で list query が `limit` / cursor を持ち、detail JSON を返さないことを検証する。

## 実施済み検証

disposable sandbox で次を実行し、成功した。

```text
npx tsx --test scripts/tests/database-schema-v2.test.ts
```

結果:

- tests: 4
- pass: 4
- fail: 0

## Refactor Classification

- 判定: same-plan prerequisite
- 理由: V2 schema 定数化と storage/API 分割は `docs/design/data-loading-performance-audit.md` の実装前提であり、目的・変更範囲・検証軸が現 task に従属する。
- 影響範囲: DB schema、migration script、session/audit storage、IPC/preload、renderer hydration。
- 検証影響: schema test、migration fixture test、storage pagination test、IPC/preload test が必要。

## Archive Readiness

- 現 plan の archive 前に必要なこと:
  - root session が proposal を canonical docs / repo 正本へ統合する。
  - `questions.md` は現時点で追加質問なしのため、repo plan 側では `質問なし` または `確認済み` の状態にする。
  - `result.md` / `worklog.md` に統合コミットを記録する。
- archive destination: `docs/plans/archive/2026/04/20260427-identify-data-loading-optimizations/`
