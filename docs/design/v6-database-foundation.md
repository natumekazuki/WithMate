# V6 Database Foundation

- 作成日: 2026-06-22
- 対象: V6で採用する保存構造、destructive reset、legacy data境界
- Status: Draft

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

## V6 Project Scope

V6 Memoryはlegacy `project_scopes`を再利用しない。
V6専用のproject scope identity tableを新設する。

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

## Session And Audit

V6ではsession履歴も再設計対象にする。
V5以前sessionは移行しない。
V6 session tableは、V6 runtimeで必要なmetadata、provider thread identity、Character snapshot reference、workspace/project contextを明示的に保持する。

auditは通常turn、Memory mutation、runtime binding、diagnosticsを分離して設計する。
legacy MemoryGeneration / Character Reflection / Monologue auditは移行しない。

## Implementation Order

1. V6 DB source of truthを固定する。
2. V6 DB file naming / destructive reset / backup policyを決める。
3. Character / app settings / provider settings / model catalogの継続範囲を固定する。
4. V6 sessions / messages / audit / project scope / Memory schemaを定義する。
5. V6 fresh DB作成pathを実装する。
6. legacy storage / UI / reset targetを削除またはV6外へ退避する。
7. V6 Memory contract / storageを新DB上に実装する。

## Open Questions

- V6 DB file nameを`withmate-v6.db`にするか。
- V5以前DBをrename backupするか、完全に無視するか。
- app settings / provider settings / model catalogの移行を自動化するか。
- V6 session / message schemaをどこまでV5から整理するか。
- Character file storageを現行pathのまま使うか、V6用にrootを分けるか。

## Next Decisions

Storage実装へ進む前に、次の順序で固定する。

1. V6 DB file nameとfresh DB作成path。
2. V5以前DBをmigration対象外にしたうえで、backup renameするか完全に無視するか。
3. Character definition以外でV6へ引き継ぐapp settings / provider settings / model catalogの範囲。
4. V6 sessions / messages / audit / project scope / Memory tablesの最小schema。
5. Character file storage rootを現行pathのまま使うか、V6用に分けるか。
