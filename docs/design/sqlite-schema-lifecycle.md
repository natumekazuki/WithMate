# SQLite Schema Lifecycle

- 作成日: 2026-07-12
- 対象: WithMate 新実装のSQLite database bootstrap、schema version管理、現行schema間migration
- 状態: 設計の基準
- 関連設計: `docs/design/multi-agent-persistence.md`, `docs/design/session-run-message-contract.md`

## 目的

WithMate新実装が所有するSQLite database fileを安全に識別し、初期schemaを再現可能に作成し、新実装の提供開始後に必要となるschema変更だけを前進migrationとして適用する。

本書はdatabase fileのlifecycleとschema適用手順を定める。現行tableの列、制約、indexはschema artifactとmanifest、cross-table transaction境界は`docs/design/multi-agent-persistence.md`を正本とし、本書へ重複させない。

## 対象範囲

- 空の新規database fileへの初期DDL適用
- WithMate新実装のdatabase file識別
- 現在のschema versionの読取りと対応可否判定
- 新実装の提供開始後に作成されたdatabaseへの順序付き前進migration
- bootstrap / migrationの排他、transaction、失敗時挙動
- schema適用後の機械的検証

## 対象外

- 旧WithMate DBからのdata migration、import、compatibility reader、変換script
- 旧schemaを入力にしたmigration test
- schema downgradeと古いapplication binaryによる新schemaへのwrite
- user操作による任意version指定、migration skip、強制的なdatabase再作成
- repository API、Application Service、CLI operationの具体型
- 自動retentionとProvider側会話削除のpolicy

## Database identityとversion

### `application_id`

- 新実装のdatabaseには、WithMate v4を表す`0x574D5634`（ASCII `WMV4`、decimal `1464686132`）を`PRAGMA application_id`として設定する。
- 定数値はversioned manifestを通じて維持し、変更しない。DDLとcontract testは同じ値を固定する。
- 既存fileの`application_id`が期待値と異なる場合、そのfileへDDLやmigrationを一切適用せず、`database_identity_mismatch`で起動を停止する。
- `application_id`の一致だけでschema互換とはみなさず、`user_version`とschema検証を続ける。

### `user_version`

- WithMate schema versionの正本は`PRAGMA user_version`とする。SQLite内部の`schema_version`はapplication migration番号として使用しない。
- 最初のversioned DDLをschema version `1`とする。新規databaseには現行versionの完全DDLを適用し、以後は互換性のない意味変更だけでなく、table、column、index、trigger、制約または保存形式を変更するたびに整数を1ずつ増やす。
- 各versionは直前versionからのmigrationを1つだけ持つ。versionの飛び越し、分岐、同じversion番号のDDL差替えを禁止する。
- applicationは`currentSchemaVersion`と`minimumSupportedSchemaVersion`を持つ。現行実装では`currentSchemaVersion=2`、`minimumSupportedSchemaVersion=1`とする。
- `user_version > currentSchemaVersion`は`database_schema_too_new`、`0 < user_version < minimumSupportedSchemaVersion`は`database_schema_too_old`としてread/writeを開始しない。

## 起動時の分類

Persistence Workerがrepositoryを公開する前に、databaseを次の順で分類する。同じfileへ接続する他のworker、Renderer、CLI operationは分類とschema適用が完了するまで開始しない。

| 状態 | 判定 | 動作 |
| --- | --- | --- |
| 新規 | fileが存在しない、またはSQLite schema objectを持たない空database | 初期bootstrapを実行する |
| 初期化中断 | 期待する`application_id`または`user_version=0`だがuser tableがない | 初期bootstrapを最初から再実行できる |
| 現行 | identity一致、`user_version=currentSchemaVersion` | schema検証後にrepositoryを公開する |
| upgrade対象 | identity一致、対応範囲内の古い`user_version` | 不足migrationを昇順適用する |
| 新しすぎる | identity一致、`user_version>currentSchemaVersion` | fileを変更せず起動を停止する |
| 非対応または不明 | identity不一致、version不正、`user_version=0`でuser tableがある | fileを変更せず起動を停止する |

旧DB fileはpath、table名、columnの推測で新規またはupgrade対象へ分類しない。旧DBは参照、変更、自動削除せず、別fileとして残す。

Persistence Workerは新DB専用pathを呼出側から明示的に受け取り、directory内の既存DBを探索またはfallback候補化しない。既知の旧DB pathと一致する入力はopen前に拒否する。

既存DBの拒否判定は元fileを変更しないinspectionで行う。WALまたはrollback journalがない場合はSQLiteのimmutable read-only URIで直接検査する。`-wal`または`-journal`が残る場合はmain DBとsidecarを一時directoryへsnapshotし、snapshot側でWAL読取りまたはhot journal recoveryを行う。snapshot作成中に元fileのsizeまたは更新時刻が変化した場合は競合として停止する。

## 初期bootstrap

1. schemaを利用する他のconnectionがない状態でdatabaseを開く。
2. `application_id`、UTF-8 encoding、`auto_vacuum=INCREMENTAL`をtable作成前に設定し、読戻して期待値を確認する。
3. 1つのwrite transactionで現行manifestに列挙したtable、index、必要なtriggerを作成する。
4. 同じtransaction内で現行`user_version`を最後に設定する。
5. commit後に`foreign_key_check`、`quick_check`、正規化した`sqlite_schema`定義全体のmanifest hash、期待するtable / index / trigger集合、`application_id`、`user_version`を検証する。
6. `journal_mode=WAL`を設定して戻り値が`wal`であることを確認する。connection単位の`foreign_keys=ON`、`busy_timeout=5000`、`wal_autocheckpoint=256`、`journal_size_limit=67108864`もrepository公開前に設定・確認する。

`schema/sqlite/v1.sql`とmanifestはimmutableなversion 1 artifactとして維持する。新規databaseの現行完全DDLは`schema/sqlite/v2.sql`とmanifestを使い、version 1 databaseには`1-to-2.sql`を前進migrationとして適用する。いずれのschema artifactもheader PRAGMA、write transaction、`user_version`を含めず、commit後検証、WALとconnection PRAGMAはPersistence Workerが所有する。

DDLまたは検証に失敗した場合はrepositoryを公開しない。transaction内の失敗はrollbackし、中断後にuser tableが残らないことを要求する。作成途中のfileを正常databaseとして扱わず、既存の別databaseや旧DBを代替として開かない。

`journal_mode=WAL`はtransaction外で設定する。WALへ移行できない環境では別journal modeへ暗黙fallbackせず、`database_wal_unavailable`として起動を停止する。

## 現行schema間migration

### Migration artifact

- migrationは`fromVersion -> toVersion`、適用SQLまたは明示的な変換処理、適用後検証を持つ順序付きmanifestとしてrepository内で管理する。
- 初期DDLはversion 1の完全なschema snapshotとする。新規databaseへ過去migrationを順番に適用して現行schemaを作らない。
- release済みmigrationを編集、並べ替え、削除しない。変更が必要な場合は次versionのmigrationを追加する。
- migrationで使用するSQLite機能は、applicationに同梱するSQLite runtimeの最低versionでcontract testする。

### 適用手順

1. identity、現在version、対応範囲をread-onlyで確認する。
2. schema利用者を停止し、Persistence Workerだけがmigration ownerとなる。
3. 最初のmigration前にSQLite backup API相当の整合したbackupを作成する。WAL使用中の`.db` file単体copyをbackupとして扱わない。
4. 不足migrationをversion順に1件ずつ適用する。
5. 各migrationは1つのwrite transactionでschema / data変換を行い、適用後検証に成功した後、同じtransactionの最後に`user_version=toVersion`を設定してcommitする。
6. 各commit後にidentityとversionを読戻す。全migration完了後に`foreign_key_check`、`quick_check`、正規化した`sqlite_schema`定義全体のhashを含む現行schema manifestとの一致を確認してからrepositoryを公開する。

SQLiteのtransaction内で実行できない操作は通常migrationへ混ぜない。`VACUUM`、journal mode変更、長時間の全件再構築が必要な場合は、容量見積り、crash recovery、再開判定を持つ専用maintenance設計を先に追加する。

### 失敗と再開

- migration失敗時は実行中の1 migrationだけをrollbackし、それ以前にcommit済みのversionは保持する。
- applicationはProvider実行、Session操作、background maintenanceを開始せず、失敗した`fromVersion -> toVersion`と安全な診断codeを返して起動を停止する。
- 自動的なdatabase削除、空schemaでの上書き、旧DBからの再import、downgradeを行わない。
- 再起動時はcommit済みの`user_version`から同じ順序で再開する。migration処理は未commitの途中状態が残らないことを前提とし、外部副作用を持たせない。
- backupからの復元は明示的な復旧操作とし、通常起動中に自動実行しない。backup保持期間とuser向け復旧UIは実装前に別途定める。

## DDLとmigrationの責務境界

| 関心事 | 正本 |
| --- | --- |
| 現行tableのcolumn、FK、CHECK、UNIQUE、index、trigger | schema version 2のDDL artifactとmanifest |
| 新規databaseへ現行schemaを作る完全DDL | schema version 2のDDL artifact |
| database identity、version判定、適用順、失敗時挙動 | 本書 |
| version間のschema / data変換 | 各migration artifact |
| repository methodとwrite ownershipの具体型 | 後続のPersistence Worker / repository設計 |
| operation単位の競合と期待結果 | contract test設計 |

## 検証 Gate

- 空databaseへのbootstrapがversion 2の完全schemaを作り、2回目の起動がDDLを再適用しない。
- bootstrap中の各失敗点で、次回起動が中途半端なschemaを現行扱いしない。
- `application_id`不一致、`user_version=0`かつuser tableあり、負数、対応範囲外、未来versionをfile無変更で拒否する。
- 旧DB fileを新規作成、upgrade、削除の対象にしない。
- 各migrationが直前versionだけを入力とし、成功時にだけschema変更と`user_version`が同時commitされる。
- migrationの途中失敗後、再起動が最後にcommit済みのversionから再開する。
- migration完了後に`foreign_key_check`が0件、`quick_check`が`ok`となり、正規化したtable / index / trigger定義全体のmanifest hashと一致する。
- migration前backupがWALを含む整合したsnapshotであり、backup失敗時にmigrationを開始しない。
- future schemaを古いapplicationが変更せず、downgradeしない。
- 初期DDLから作成した現行schemaと、最古の対応versionから全migrationを適用した現行schemaが同じschema manifestへ一致する。

## 次の作業入口

1. `scripts/validate-sqlite-schema.py`の代表検証をtest runnerへ統合し、各tableの検証Gateをcontract testへ拡張する。
2. 次のschema変更ではversion 2 artifactを変更せず、`2 -> 3` migrationと現行完全DDLを追加する。

## 参照

- SQLite Database File Format: `application_id`と`user_version`のdatabase header契約
- SQLite PRAGMA: `application_id`、`user_version`、`auto_vacuum`、`foreign_key_check`、`quick_check`
- SQLite Transactions: schema変更を含むtransaction境界
- SQLite ALTER TABLE: SQLiteで直接変更できるschema操作とtable再構築が必要な変更
- SQLite Write-Ahead Logging: WAL有効化、永続性、checkpoint契約
