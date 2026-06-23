# V6 Database Foundation

- 作成日: 2026-06-22
- 対象: V6で採用する保存構造、destructive reset、legacy data境界
- Status: Foundation schema implemented

## Goal

V6では、MemoryだけでなくSQLite DB定義全体を再設計する。
V5以前のsession / legacy Memory / Growth互換を引き継がず、Character-first資産とapp基本設定を残しながら、V6 runtimeに必要なtableを新規に定義する。

## Position

- 本書をV6 database foundationのsource of truthとする。
- current DB構造の棚卸しは`docs/design/database-schema.md`を参照する。
- V6 Memoryのdomain contractは`docs/design/v6-memory-foundation.md`を参照する。
- V5 Character catalog / definition / snapshotの意味はV5 source of truthを優先する。

## Migration Boundary

V6はbackward-compatible database migrationを目標にしない。
V5以前のsession履歴、legacy Memory、Growth、provider instruction projectionは保持要件にしない。

引き継ぐ:

- Character catalog
- `character.md`
- `character-notes.md`
- Character icon / theme / metadata
- app settings
- provider settings
- model catalog
- V6 runtimeに必要な最小diagnostics / feature flag

引き継がない:

- V5以前のsession履歴
- `session_memories`
- `project_scopes`
- `project_memory_entries`
- `character_scopes`
- `character_memory_entries`
- MemoryGeneration履歴
- Mate Profile / Growth
- provider instruction sync projection
- legacy Memory UI state
- legacy Project Memory import / viewer

## Destructive Reset Policy

V6 migrationではdestructive resetを許容する。
既存DBをin-placeで意味変更せず、V6用DBを新規作成する。
必要なら旧DBはrename backupまたはarchive対象にしてよいが、V6 runtimeの正本にはしない。

V6 first releaseでは次を提供しない。

- V5以前sessionの再実行互換
- legacy Memoryの自動migration
- legacy Memoryのimport preview
- legacy Memory viewer
- legacy Project Memoryの復元

release前に必要なら、destructive resetのwarningまたはmanual backup導線だけを追加する。

## Database Shape

V6 DBは次のdomainに分ける。

| Domain | 方針 |
| --- | --- |
| App settings | 継続。ただしlegacy Memory / Growth設定は移行しない |
| Provider settings | 継続 |
| Model catalog | 継続 |
| Character catalog | 継続 |
| Character files | `characters/<character-id>/`を継続 |
| Sessions | V6用に再設計。V5以前session履歴は移行しない |
| Messages | V6用に再設計 |
| Audit | V6用に再設計。legacy background auditは移行しない |
| Memory | V6専用tableで新設 |
| Project scope | V6専用tableで新設 |
| Runtime binding | V6専用tableまたはMain Process memoryで新設 |

## Schema Source

V6 DBの最小SQL正本は`src-electron/database-schema-v6.ts`に置く。
first foundationでは、active runtime DB path selectionには接続せず、`withmate-v6.db`用のfresh DB作成path helperとschema検証だけを実装する。

- DB file name: `withmate-v6.db`
- schema version: `PRAGMA user_version = 6`
- fresh DB path: `<userData>/withmate-v6.db`
- fresh DB bootstrap: `src-electron/app-database-v6-bootstrap.ts`
- required table list: `REQUIRED_V6_TABLES`
- schema verification: `isValidV6Database()`
- targeted tests: `scripts/tests/database-schema-v6.test.ts`、`scripts/tests/app-database-v6-bootstrap.test.ts`

V6 schemaは`app_settings`、`model_catalog_*`、`characters`を継続する。
継続tableのDDLも`database-schema-v6.ts`が所有し、V1などlegacy schema fileからimportしない。
V6 runtime固有のproject / session / message / audit / Memoryは、legacy tableと混同しないようにV6専用tableで定義する。
`isValidV6Database()`はfilename / `user_version` / required tableに加え、forbidden legacy table、主要column、主要index、主要foreign key、主要CHECK、`PRAGMA foreign_key_check`を確認する。
`createOrVerifyV6FreshDatabase()`はfresh V6 DB作成と既存valid V6 DB検証だけを行う。既存invalid V6 DBは破壊的に上書きせず、active runtime DB path selectionにも接続しない。
diagnosticsは`withmate-v6.db`を既知fileとして表示するが、V6 foundation DBがV4 DBと並存しても複数runtime generation warningの対象にしない。

## V6 Project Scope

V6 Memoryはlegacy `project_scopes`を再利用しない。
V6専用の`project_scopes_v6` identity tableを新設する。

project scope解決の入力には、current sessionのworkspace metadataとGit metadataを使ってよい。
ただし、保存先とIDはV6 DBが所有する。

保存する最小情報:

- `id`
- `project_type`
- `project_key`
- `workspace_path`
- `git_root`
- `git_remote_url`
- `display_name`
- `created_at`
- `updated_at`

`display_name`はrepo名またはdirectory名など人間向け表示名として扱う。
Memory entryのowner / scopeには表示名ではなくV6 project scope IDを保存する。

## V6 Memory Tables

Memory entry、tag、relation、mutation event、idempotency keyはV6専用tableで持つ。
legacy Memory tableは読まない、書かない、意味変更しない。

V6 Memory schema detailは`docs/design/v6-memory-foundation.md`を正本にする。

Foundation schemaでは次を作る。

- `memory_entries_v6`
- `memory_entry_tags_v6`
- `memory_entry_relations_v6`
- `memory_tag_catalog_v6`
- `memory_mutation_events_v6`
- `memory_idempotency_keys_v6`
- `memory_idempotency_forget_results_v6`

Memory idempotencyは`binding_id_hash / key / operation / owner / scope`をidentityに含める。
`binding_id_hash`はbinding本体ではなく短命referenceのhashだけを保存する。
同じidentityで`request_fingerprint`が一致しない場合はretryではなくconflictとして扱う。
batch forgetのentry別結果は`memory_idempotency_forget_results_v6`へ保存する。
Memory mutation ledgerは`result_status`をfirst-class columnとして持つ。

## Session And Audit

V6ではsession履歴も再設計対象にする。
V5以前sessionは移行しない。
V6 session tableは`sessions_v6`とし、V6 runtimeで必要なmetadata、provider thread identity、Character snapshot reference、workspace/project contextを明示的に保持する。
resume時に実行policyがdefaultへ戻らないよう、`catalog_revision`、`approval_mode`、`codex_sandbox_mode`、`allowed_additional_directories_json`、`session_kind`、`custom_agent_name`、`runtime_policy_json`を保存する。
Character付きsessionでは`character_snapshot_json`をvalid JSONとして必須にし、neutral sessionでは`NULL`を許可する。
message tableは`session_messages_v6`とし、V5以前message履歴は移行しない。
Memory provenanceはapp messageを指す`source_app_message_id`とprovider外部IDを指す`source_provider_message_id`を分ける。

auditは`audit_events_v6`で通常turn、Memory mutation、runtime binding、diagnosticsを分離して設計する。
legacy MemoryGeneration / Character Reflection / Monologue auditは移行しない。

## Implementation Order

1. V6 DB source of truthを固定する。
2. V6 DB file naming / destructive reset / backup policyを決める。
3. Character / app settings / provider settings / model catalogの継続範囲を固定する。
4. V6 sessions / messages / audit / project scope / Memory schemaを定義する。
5. V6 fresh DB作成pathを実装する。完了: `createOrVerifyV6FreshDatabase()`でfresh作成 / existing valid検証 / invalid拒否を行う。
6. legacy storage / UI / reset targetを削除またはV6外へ退避する。
7. V6 Memory contract / storageを新DB上に実装する。

## Open Questions

- V5以前DBをrename backupするか、完全に無視するか。
- app settings / provider settings / model catalogの移行を自動化するか。

## Next Decisions

Storage実装へ進む前に、次を固定する。

1. V5以前DBをmigration対象外にしたうえで、backup renameするか完全に無視するか。
2. app settings / provider settings / model catalogの移行を自動化するか。
3. Character file storage rootを現行pathのまま使うか、V6用に分けるか。
4. V6 storage実装で、`src-electron/database-schema-v6.ts`のtableへだけwriteすることを確認する。
