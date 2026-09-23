# V6 Database Foundation

## 継続データの境界

V6 runtimeの正本は`<userData>/withmate-v6.db`である。旧DBをin-placeでV6へ書き換えない。起動時の選択・migrationは`src-electron/storage/app-database-path.ts`、V6 schemaのSQLと検証は`src-electron/storage/database-schema-v6.ts`を正本とする。[Database Schema](database-schema.md)は現在の保存領域と参照先を示す。

旧DBからV6へ自動継続するのは、Character catalogと定義file・icon・theme・metadata、app／provider settings、model catalogなどV6の利用に必要な情報である。Character file rootは`<userData>/characters/<character-id>/`を継続する。V5以前のSession履歴、旧Memory、Growth、provider instruction projectionはV6の正本へ取り込まない。旧DBはmigration sourceまたはbackupとして扱い、通常のV6保存先にしない。

`app_settings.v4_to_v6_release_data_migrated_at`はV4からの継続データcopy完了markerである。validな空V6 bootstrap DBが先に存在しても、未移行のvalid V4があれば継続データを取り込む。marker済みなら再copyとmigration progress表示を行わない。既存invalid V6 DBを黙って上書きせず、source DBと共有file・blobをmigrationの副作用で破壊しない。

## Runtime ownerとschema

V6 SQLiteのschema/bootstrap、通常保存、WAL maintenance、診断はstorage Workerが所有する。Mainはtyped commandを非同期に送り、任意SQLや同期SQLite接続をWorker境界へ追加しない。close／reset／reopenではgenerationを交換し、旧generationの遅延応答を新DBの書込みへ使わない。resetはユーザーデータの暗黙削除や、結果不明のcommitの自動再送を許可しない。

V6 schemaは設定・catalog、Project scope、Main／Auxiliary Session、message、turn、Memory、Character Affectを分ける。Memoryの保存と権限は[V6 Memory Foundation](v6-memory-foundation.md)、Auxiliaryの会話・draft・summaryは[Auxiliary Session](auxiliary-session.md)に記す。

`sessions_v6.incarnation_id`は同じSession IDの削除・再作成を区別する。既存V6行の列補完と、旧pending Affect settlementのowner解釈はschema更新で扱い、既存の本文やcorrelation fingerprintを変更しない。通常の保存と取消は[Session Run Lifecycle](session-run-lifecycle.md)に従う。

turn contextはMain SessionかAuxiliaryの一方をownerとし、`session_turns_v6`にphaseとterminal markerを置く。`session_turn_interims_v6`と`session_turn_provider_outputs_v6`はinterimとprovider outputを分離する。保存済みfinal message、detail audit、provider outputを同じものとみなさず、通常画面で不要なraw/detailは対象を開いたときに取得する。既存V6 auditからの更新は`src-electron/storage/migrations/migrate-session-turn-storage-v6.ts`が担当する。

## 検証

`isValidV6Database()`はDB名、version、必須／禁止table、主要column・index・foreign key・CHECK、foreign key integrityを検証する。boot diagnostics向けのshallow検証はその代用ではない。fresh DB作成は一時領域でschema作成とdeep validationを終えてから、既存fileを上書きせずpublishする。関連する検証は`tests/main/database-schema-v6.test.ts`、`tests/main/app-database-v6-bootstrap.test.ts`、`tests/main/app-database-path.test.ts`にある。
