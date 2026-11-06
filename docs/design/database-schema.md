# Database Schema

## 現行DBと正本

通常起動の保存先は `<userData>/withmate-v6.db`（`PRAGMA user_version = 6`）である。V6のtable、column、index、foreign key、CHECKの実定義は`src-electron/storage/database-schema-v6.ts`を正本とする。起動時の選択とmigrationは`src-electron/storage/app-database-path.ts`、fresh DB作成と検証は`src-electron/storage/app-database-v6-bootstrap.ts`が担当する。

永続化データの正本と、Markdownやprovider instructionなどのgenerated projectionを混同しない。生成された投影は手編集を正本とせず、削除・忘却した情報を再投影やproviderへの送信に残さない。

背景三用途のProvider／model／任意のreasoningEffort・用途別権限・登録本文は`app_settings`の`background_execution_settings_json`、Memory二用途の頻度は`memory_recording_frequencies_json`に保存する。既存AppSettingsの読込・保存・変更通知を用い、キー欠落時だけ初期化し、不正値を既定値へ置換しない。選択未設定と本文未設定・空文字列を区別する。

元会話×用途の背景native thread ID・前回失敗・待機通知はアプリruntime内だけで保持し、DBへ保存しない。再起動時に過去の待機や失敗範囲を自動復元しない。保存済みMemory／Affectはそのまま保持し、生成・登録対象の完了cursorや実行台帳は設けない。実行ごとの認可と継続の契約は[Background Execution](background-execution.md)を参照する。

V6 SQLiteの起動、schema更新、WAL maintenance、診断、通常の保存操作はstorage Workerが所有する。Mainは許可されたtyped commandを非同期で送る。close、reset、reopen後に旧storage generationの遅延応答を新しいDBへ適用しない。

## Storage Overview

| 領域 | 主な正本 |
| --- | --- |
| 設定・catalog | `app_settings`、`prompt_templates`、`provider_model_cache`、`characters` |
| Project | `project_scopes_v6` |
| Main Session | `sessions_v6`、`session_messages_v6` |
| Turn Queue | `session_turn_queue_v6` |
| Files Pin | `session_file_pins_v6` |
| Session Graph | `session_graphs_v6`、`session_graph_topics_v6`、`session_graph_records_v6`、`session_graph_relations_v6` |
| Coordination | `coordination_records_v7` |
| Auxiliary | `auxiliary_sessions`、`auxiliary_session_messages`、`auxiliary_session_drafts` |
| Turn | `session_turns_v6` |
| Memory | `memory_*_v6` |
| Character Affect | `character_affect_*_v6` |

Mainの`sessions_v6.incarnation_id`は同じSession IDの削除・再作成を区別する。既存行限定の更新はIDだけでなくincarnationを照合する。Auxiliaryは親Sessionに従属し、metadataと順序付きmessage行、artifact詳細を分離する。独立draftの正本は`auxiliary_session_drafts`であり、一覧の最終使用順には会話更新時刻とdraft更新時刻の新しい方を使う。詳細は[Auxiliary Session](auxiliary-session.md)を参照する。

turnはMainまたはAuxiliaryの一方だけをownerとし、phase、実行設定、message位置、thread、時刻、error summaryを`session_turns_v6`へ保存する。会話本文と操作結果の正本は通常履歴と`MessageArtifact.operationTimeline`であり、軽量messageと重いartifact detailを分け、detailは対象を開いたときに取得する。開始と終端の最小turn保存、取消・失敗判定、Timingとの関連付けは[Session Run Lifecycle](session-run-lifecycle.md)を参照する。

失敗したassistant messageは生成本文`text`と失敗理由`runFailure`を分けてJSONへ保存する。本文に通知を含む既存の保存データは、同ownerのfailed turnとassistant message位置・error summaryが一致する通知末尾だけを読取時に分離する。生成本文に似た文字列があるだけでは失敗と判定せず、保存済みの本文・artifact・bookmarkは破壊しない。全件・page・会話queryで同じ本文投影を使用する。

質問formの記録は通常assistant messageの`elicitationRecords`へ保存し、Main／Auxiliaryの表示pageにも含める。質問文・選択肢・form回答状態に加え、質問種別と本文内の位置`textRange`を保持する。範囲を持つ質問は元の本文に含まれ、長さ0の範囲は本文を持たない質問の挿入位置を表す。位置のない既存記録は本文の後ろに表示する。入力値や既定値、再操作用のlive requestは保存しない。保存されたpending状態は失効済みとして読み、古い要求を復元しない。既存message JSONの任意fieldを使い、別tableや質問専用の永続queueは持たない。

Turn Queueは次の項目を保持する。

- 親Session ID
- 任意のAuxiliary ID
- 対象incarnation
- 呼出元request ID
- 受付順
- 実行順
- 編集可能な実行予定入力（`captured_json`）
- 不変の受付時入力（`accepted_json`）
- dispatch claimで固定した採用入力（`dispatched_json`）
- 状態
- 最小turn ID／user seq
- 追加入力先Turn ID
- 結果不明後の明示解放時刻

受付順の`sequence`は不変で履歴cursorにも使用し、並べ替え可能な`queue_position`を実行順の正本とする。新規受付と当該列を持たない既存DBの初期値はsequenceとする。

receiptのUUIDは受付時から終端後まで同じexecution identityである。新規受付は実actorの会話・incarnation・Turn、操作と明示宛先をoriginとして入力に含める。GUI入力はGUI起点として区別する。受付時入力は再試行照合元であり、編集と追加入力では変更しない。採用入力は通常dispatchとqueue経由Steerのclaimで本文・添付を一緒に固定し、Provider未呼出が確認されたqueued復帰でのみ固定を解除する。固定はProvider受信の証明ではない。原文・採用入力が保存されていない既存行はNULLのまま保持し、現在の入力から補わない。

Sessionからの送信とCoordination配送のoriginには、受付時の送信元・宛先のSession名とCharacterのID・名前・icon参照を表示snapshotとして含める。snapshotは表示用であり、認可・navigationには実Session identityを使う。再試行や予定入力の編集で保存済みsnapshotを現在の名前・Characterへ付け替えず、snapshotのない既存originへ現在値を補記しない。

送信側の読取は、表示中の保存message seqを既存Turnへ一括解決し、receiptの`accepted_json.origin`にある送信actorのkind・Session・incarnation・Turnを完全一致させる。実行中は明示されたWithMate Turnだけを追加対象にし、Provider native IDや最新Turnから推測しない。既存receiptのexpression indexを使い、受付sequenceのkeysetで最大20件ずつ、本文は320文字の原文previewとして返す。全文と配送・受信Turnの結果は返却された正確な宛先とreceiptから共通execution読取で取得する。送信本文の別保存や会話messageの複製は行わない。

Main／Auxiliaryの対象owner・request IDをそれぞれ一意にし、親または対象Auxiliary削除でreceiptも削除する。receiptは通常messageとは別の受付・実行状態であり、会話本文やturnの正本を置換しない。受付・開始・終端のtransaction境界は[Electron Session Store](electron-session-store.md#turn-queue)を参照する。

会話の表示用readはmetadataと最新60件を返し、過去の本文は60件単位で取得する。messageの`historyIndex`は保存行の`seq`で、`messageCount`は会話全体の件数である。Mainの表示metadataは末尾pageより前にある場合も最新user messageを保持する。

表示pageは保存用full Sessionとは区別し、storageの全文保存入口はpageを拒否する。rendererのmetadata更新はincarnationを照合した最新保存履歴へ適用し、paged本文で履歴を置換しない。turn runtimeはmetadataと全体件数、当該turnで追加したmessageだけを保持し、開始・追加入力・終端を専用commandで追加する。履歴を必要とするconsumerのfull readは明示的な別経路で保持する。

全履歴検索とMessages navigatorは、storage ownerの短いindexed cursor batchと、DBを所有しないCPU Workerで処理する。検索のsourceは保存本文、previewはMarkdownの表示検索投影を使い、全件のmatch数、messageの`seq`、message内の`occurrenceIndex`を維持する。

結果は任意offsetから最大64件と総件数を返し、全本文・全matchの配列を転送・保持しない。Navigatorはuser／assistantだけを対象とし、Bookmarkを投影前に絞り、previewは最大160 Unicode codepointとする。

継続pageはrequest ID、generation、会話owner、対象revisionを照合し、変更・取消・失効を成功0件と区別する。所有と取消・上限は[V6 Database Foundation](v6-database-foundation.md#runtime-ownerとschema)を参照する。

Memoryのowner、scope、忘却、idempotency、保護対象fileは[V6 Memory Foundation](v6-memory-foundation.md)と[V6 Memory Protected Objects](v6-memory-protected-objects.md)を参照する。Characterの定義fileは`<userData>/characters/<character-id>/`に置き、catalog metadataとsession snapshotの境界は[Character Storage](character-storage.md)を参照する。

Memory出典の`source_session_id`は実Main、`source_auxiliary_session_id`は実Auxiliaryを参照する。Auxiliary登録ではMain側をNULLにし、同名IDを親Mainへ代用しない。Auxiliary削除では出典FKをSET NULLにして登録済みMemory本文・targetを保持する。既存V6への列追加はWorkerの`ensureV6Schema`で行い、保存済みentryを作り直さない。公開readの`source.auxiliarySessionId`は出典がある場合だけ返し、MCP／CLIで同じ契約を使う。

## Character Affect

`character_affect_*_v6`をMain／Auxiliaryで共用する。session-layer eventとresetのscope ownerはMainの`session_id`かAuxiliaryの`auxiliary_session_id`の一方だけで、対象会話削除時にcascade削除する。relationship-layerは両scope列をNULLとし、Character／local-user単位で全会話に共有する。発生元は`source_session_id`か`source_auxiliary_session_id`に保持し、削除時はprovenanceだけをNULLにする。mutation／observationの会話参照も削除時にNULLとなる。

内部`sessionSource`が実kind・incarnation・親identity、背景では既存WorkerのownerIdentityを伝え、同名Main／Auxiliaryを区別する。未指定の既存入力はMainである。projection／version／inspect／correct／resetは同じownerを使う。別会話の一時感情は既存afterglowのread-time規則だけで合成し、relationshipへ転写しない。詳細は[ADR018](../adr/018-character-affect-event-persistence.md)に従う。

schema ensureは既存Affect tablesの列・CHECK・FKを更新する際、接続するevent／reset／idempotency／mutation／observationを同じsavepoint内で再構築する。既存Main行、ID、Memory link、fingerprint、監査をコピーして保持し、Mainのstate versionを変更しない。Memory tablesと保存本文は対象外で、`user_version`は6を維持する。

## Coordination

`coordination_records_v7`はCrew起点Mainをownerとし、起票元の実Main／Auxiliary identity・Turn、元依頼receiptと保存originの実呼出元、現在の回答担当、本文・選択肢、回答revision、明示操作の履歴を保持する。回答担当の変更で起票元は変えない。参照は全Crewへ公開するが、更新権限は起票元・現在の担当・実ユーザーごとに検証する。実ユーザー回答はtrusted GUI入口に限る。

明示配送は通常の`session_turn_queue_v6`へ受付け、Coordinationとqueueの保存は同じWorker接続のtransaction内で行う。操作UUIDによる再試行照合は記録自身の履歴を用い、独立queue・outbox・台帳は持たない。回答revisionとreceiptを対応させ、consumeは起票元が回答identity／現在revisionを明示して行う。読出し・描画・配送だけではconsumeしない。訂正記録と訂正元の状態も同じtransactionで保存する。

取り下げと回答は併存する。取り下げは受理済み回答・queueを取消さず、その後の有効な回答も受付ける。queueの受付時入力を保ち、dispatch claim時だけ現在状態と取り下げ理由を採用入力へ追加する。回答原文・送信者・revisionは最新回答へ差し替えない。Coordinationは既存Provider質問・承認やGUI Steerへ変換しない。

起票Turn終了・Window close・再起動で記録は失効しない。Crew削除は未対応記録の起票元・現在のAgent担当と通常queueの既存guardで判定し、成立したCrew全体削除ではCrew所有記録をcascade削除する。終了済み履歴はCrewが存続する間保持する。

詳細取得は起票元の保存identityから共通execution read用の`initiatorTarget`を投影する。Auxiliaryでは現在の親Main identityも同じ読取transactionで解決し、記録自身へ重複保存しない。存在しない記録・明示指定された削除済みCrew／Mainの照会は`COORDINATION_DELETED`としてGUIへ返す。通信失敗や認可失敗をこの終端結果へ変換せず、一時取得失敗と削除済み表示を区別する。

## Session Graph

Session Graphも親MainのID/incarnationを所有境界とし、Mainと配下Auxiliaryが共有する。親削除で全記録をcascade削除し、AuxiliaryのCloseでは消さない。構造・競合・MCP・表示の契約は[Session Graph](session-graph.md)を参照する。

起動時の`ensureV6Schema`は、`app_settings.session_graph_agent_origin_contract_initialized_at`が未設定の場合に全Session・全TopicのGraph専用4 tableの行をrevision・payloadごと初期化する。Graphの初期化とmarker保存は同じtransaction内で行い、Window／MCPの利用前に完了する。markerは設定リセットでも保持し、再呼出し・再起動では新しく保存したGraphを消さない。Session、会話・draft・turn、Memory、Affect、Character資産や参照先fileは初期化対象に含めず、旧Graphの変換・読取互換は提供しない。

## Additional Directory

Additional Directoryは`sessions_v6.allowed_additional_directories_json`にだけ保存する。Auxiliaryの保存データとAPIのmetadataにはDirectoryを持たせず、Files認可・表示・次turnの実行contextは親Mainの現在の一覧から解決する。親Mainと配下の全Auxiliaryが共有し、別のMain配下とは共有しない。

## Files Pin

`session_file_pins_v6`は親Sessionごとにroot種別、正規化root path、相対path、対象種類、root表示名を保持する。MainとAuxiliaryは同じ親SessionのPinを使い、アクセス時にはそれぞれの現在root認可を適用する。親Sessionへのforeign keyは`ON DELETE CASCADE`で、削除時にPinも削除する。新規・既存V6のschema更新はstorage Worker内の`ensureV6Schema`が行い、Session本文等を作り直さない。

root種別・root path・相対pathの識別keyを親Session内で一意にし、包含rootは別scopeとして扱う。Windowsではpathの識別をcase-insensitiveとし、相対pathの表示casingは保持する。Pinはpathへの目印で、rename追跡や内容固定を行わない。不存在・認可外でも参照を自動削除せず、一覧の利用不可状態と明示解除で扱う。

list／追加／解除は既存のtyped IPCからstorage Workerへ渡し、親Session IDとincarnationを確認する。解除はrootが除去済みでも可能だが、別親SessionのPinは変更しない。本文読込・全件index・追加watcherは用いず、登録先のmetadata確認を最大4件ずつ並列実行する。保存結果不明・取得失敗はエラーとして伝え、空のPin集合へfallbackしない。

## 起動時の移行とデータ保護

`app_settings`の`coding_provider_settings_json`にある`opencode.apiKey`はstorage ownerの起動時にそのfieldだけを除去する。他providerのkey、OpenCodeの有効化・Skill設定、Session・会話・threadは保持する。通常の設定更新serviceによるthread invalidationは通さず、読込・保存境界でもOpenCode keyを空へ正規化する。keyをnative OpenCodeへ自動移送せず、移行元DB・backup全体の削除やsecure eraseは行わない。

OpenCodeのnative DBはWithMateのSQLiteとは別にOpenCodeが所有し、通常はPC CLIの既存DBを使う。`v6.3.29-preview.20`／`v6.3.29-preview.21`のWithMate専用DBにある会話は、同梱CLI `2.2.5`と公式export／importでroot・全childのID、owner、履歴を保持してnative DBへ移す。成功後だけWithMateのthread参照を`native:<ID>`へ更新し、旧DB・WithMateの会話は残す。credentialは移さない。

DBの取り違え、owner不一致、未解消pending、active thread、移行・再開失敗では送信せず明示エラーにし、新規threadへfallbackしない。詳細は[Thread Management](provider-adapter.md#thread-management)を参照する。

Modelの無効設定は`app_settings`の`model_availability_json`へprovider別の`disabledServiceIds`／`disabledModelIds`を保存する。SDK cacheとは独立したapp共通設定とし、専用tableは設けない。未設定・設定reset時は空の設定（すべて有効）とし、不正なJSONや型は明示エラーにする。適用条件は[Model Availability](model-catalog.md#model-availability)を参照する。

SDK model一覧は`provider_model_cache`へproviderとcontext keyの組を主キーに保存する。`provider_json`と`fetched_at`を保持し、context keyやcredentialをrendererへ渡さない。更新契約は[Provider Model Discovery](model-catalog.md)を参照する。V6 schema更新では`model_catalog_models`、`model_catalog_providers`、`model_catalog_revisions`を削除する。公開済みSessionの`catalog_revision`列の保存値は保持するが、実行設定の検証には使わず、Session、会話、draft、最小turnをcatalog変更で移行しない。

V6 schema更新は`character_affect_turn_settlements`を`DROP TABLE IF EXISTS`で削除する。旧queueのpending、評価候補、retry、実行中、quarantineは再開せず、本文・候補も除去する。旧storage constructorや中断回収を起動せず、再実行・再起動でも旧評価を送信しない。破棄を評価成功として扱わず、保存済みAffect event／関連episode／一般Memoryとversion・idempotency情報は保持する。一部保存済みや保存結果不明の候補も再適用しない。

`resolveOrMigrateAppDatabasePath`は、既存のvalid V6を優先し、必要ならV4の継続データをV6へ取り込む。V6がない場合は、存在するvalid sourceに応じてV4→V6、V3→V4→V6、V2→V3→V4→V6、V1→V2→V3→V4→V6の経路を使う。sourceにないDBを選んで上書きせず、未対応の新しいV4 schemaを旧版migrationで上書きしない。V6の継続対象と非対象は[V6 Database Foundation](v6-database-foundation.md)に記す。

各migrationのsource読取りは元DBのschema、row、journal modeと、共有blob・Character fileを変更しない。新しいV6 DBがinvalidなら、黙って置換しない。既存の空V6 DBとV4が共存する場合も継続データを移し、完了markerで再copyを防ぐ。migration実装は`src-electron/storage/migrations/`、既存データの選択は`app-database-path.ts`で確認する。

起動時の退役データcleanupは、管理対象のV6・移行元DB・backupからCompanion専用table／行、専有file・blob・SessionFolderと専用Git namespaceだけを対象とする。

通常Session／最小turn、共有Memory／Affect本文、共有file・blob、target branch、他worktree、stashは保持する。退役Session由来の共有データはsource linkageを除去またはNULL化する。

詳細な対象判定は`src-electron/storage/migrations/companion-removal.ts`と関連helperを正本とし、一般のDB resetやmigrationによるユーザーデータの無断破棄へ拡張しない。
