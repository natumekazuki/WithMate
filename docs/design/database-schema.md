# Database Schema

## 現行DBと正本

通常起動の保存先は `<userData>/withmate-v6.db`（`PRAGMA user_version = 6`）である。V6のtable、column、index、foreign key、CHECKの実定義は`src-electron/storage/database-schema-v6.ts`を正本とする。起動時の選択とmigrationは`src-electron/storage/app-database-path.ts`、fresh DB作成と検証は`src-electron/storage/app-database-v6-bootstrap.ts`が担当する。

永続化データの正本と、Markdownやprovider instructionなどのgenerated projectionを混同しない。生成された投影は手編集を正本とせず、削除・忘却した情報を再投影やproviderへの送信に残さない。

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
| Auxiliary | `auxiliary_sessions`、`auxiliary_session_messages`、`auxiliary_session_drafts` |
| Turn | `session_turns_v6` |
| Memory | `memory_*_v6` |
| Character Affect | `character_affect_*_v6` |

Mainの`sessions_v6.incarnation_id`は同じSession IDの削除・再作成を区別する。既存行限定の更新はIDだけでなくincarnationを照合する。Auxiliaryは親Sessionに従属し、metadataと順序付きmessage行、artifact詳細を分離する。独立draftの正本は`auxiliary_session_drafts`であり、一覧の最終使用順には会話更新時刻とdraft更新時刻の新しい方を使う。詳細は[Auxiliary Session](auxiliary-session.md)を参照する。

turnはMainまたはAuxiliaryの一方だけをownerとし、phase、実行設定、message位置、thread、時刻、error summaryを`session_turns_v6`へ保存する。会話本文と操作結果の正本は通常履歴と`MessageArtifact.operationTimeline`であり、軽量messageと重いartifact detailを分け、detailは対象を開いたときに取得する。開始と終端の最小turn保存、取消・失敗判定、Timingとの関連付けは[Session Run Lifecycle](session-run-lifecycle.md)を参照する。

失敗したassistant messageは生成本文`text`と失敗理由`runFailure`を分けてJSONへ保存する。本文に通知を含む既存の保存データは、同ownerのfailed turnとassistant message位置・error summaryが一致する通知末尾だけを読取時に分離する。生成本文に似た文字列があるだけでは失敗と判定せず、保存済みの本文・artifact・bookmarkは破壊しない。全件・page・会話queryで同じ本文投影を使用する。

質問formの記録は通常assistant messageの`elicitationRecords`へ保存し、Main／Auxiliaryの表示pageにも含める。質問文・選択肢・form回答状態に加え、質問種別と本文内の位置`textRange`を保持する。範囲を持つ質問は元の本文に含まれ、長さ0の範囲は本文を持たない質問の挿入位置を表す。位置のない既存記録は本文の後ろに表示する。入力値や既定値、再操作用のlive requestは保存しない。保存されたpending状態は失効済みとして読み、古い要求を復元しない。既存message JSONの任意fieldを使い、別tableや質問専用の永続queueは持たない。

Turn Queueは親Session ID、任意のAuxiliary ID、対象incarnation、GUI request ID、受付順、捕捉値、状態、最小turn ID／user seq、追加入力先Turn ID、結果不明後の明示解放時刻を保持する。Main／Auxiliaryの対象owner・request IDをそれぞれ一意にし、親または対象Auxiliary削除でreceiptも削除する。receiptは通常messageとは別の受付・実行状態であり、会話本文やturnの正本を置換しない。受付・開始・終端のtransaction境界は[Electron Session Store](electron-session-store.md#turn-queue)を参照する。

会話の表示用readはmetadataと最新60件を返し、過去の本文は60件単位で取得する。messageの`historyIndex`は保存行の`seq`で、`messageCount`は会話全体の件数である。Mainの表示metadataは末尾pageより前にある場合も最新user messageを保持する。表示pageは保存用full Sessionとは区別し、storageの全文保存入口はpageを拒否する。rendererのmetadata更新はincarnationを照合した最新保存履歴へ適用し、paged本文で履歴を置換しない。turn runtimeはmetadataと全体件数、当該turnで追加したmessageだけを保持し、開始・追加入力・終端を専用commandで追加する。履歴を必要とするconsumerのfull readは明示的な別経路で保持する。

全履歴検索とMessages navigatorは、storage ownerの短いindexed cursor batchと、DBを所有しないCPU Workerで処理する。検索のsourceは保存本文、previewはMarkdownの表示検索投影を使い、全件のmatch数、messageの`seq`、message内の`occurrenceIndex`を維持する。結果は任意offsetから最大64件と総件数を返し、全本文・全matchの配列を転送・保持しない。Navigatorはuser／assistantだけを対象とし、Bookmarkを投影前に絞り、previewは最大160 Unicode codepointとする。継続pageはrequest ID、generation、会話owner、対象revisionを照合し、変更・取消・失効を成功0件と区別する。所有と取消・上限は[V6 Database Foundation](v6-database-foundation.md#runtime-ownerとschema)を参照する。

Memoryのowner、scope、忘却、idempotency、保護対象fileは[V6 Memory Foundation](v6-memory-foundation.md)と[V6 Memory Protected Objects](v6-memory-protected-objects.md)を参照する。Characterの定義fileは`<userData>/characters/<character-id>/`に置き、catalog metadataとsession snapshotの境界は[Character Storage](character-storage.md)を参照する。

## Session Graph

Session Graphも親MainのID/incarnationを所有境界とし、Mainと配下Auxiliaryが共有する。親削除で全記録をcascade削除し、AuxiliaryのCloseでは消さない。構造・競合・MCP・表示の契約は[Session Graph](session-graph.md)を参照する。

## Additional Directory

Additional Directoryは`sessions_v6.allowed_additional_directories_json`にだけ保存する。Auxiliaryの保存データとAPIのmetadataにはDirectoryを持たせず、Files認可・表示・次turnの実行contextは親Mainの現在の一覧から解決する。親Mainと配下の全Auxiliaryが共有し、別のMain配下とは共有しない。

## Files Pin

`session_file_pins_v6`は親Sessionごとにroot種別、正規化root path、相対path、対象種類、root表示名を保持する。MainとAuxiliaryは同じ親SessionのPinを使い、アクセス時にはそれぞれの現在root認可を適用する。親Sessionへのforeign keyは`ON DELETE CASCADE`で、削除時にPinも削除する。新規・既存V6のschema更新はstorage Worker内の`ensureV6Schema`が行い、Session本文等を作り直さない。

root種別・root path・相対pathの識別keyを親Session内で一意にし、包含rootは別scopeとして扱う。Windowsではpathの識別をcase-insensitiveとし、相対pathの表示casingは保持する。Pinはpathへの目印で、rename追跡や内容固定を行わない。不存在・認可外でも参照を自動削除せず、一覧の利用不可状態と明示解除で扱う。

list／追加／解除は既存のtyped IPCからstorage Workerへ渡し、親Session IDとincarnationを確認する。解除はrootが除去済みでも可能だが、別親SessionのPinは変更しない。本文読込・全件index・追加watcherは用いず、登録先のmetadata確認を最大4件ずつ並列実行する。保存結果不明・取得失敗はエラーとして伝え、空のPin集合へfallbackしない。

## 起動時の移行とデータ保護

SDK model一覧は`provider_model_cache`へproviderとcontext keyの組を主キーに保存する。`provider_json`と`fetched_at`を保持し、context keyやcredentialをrendererへ渡さない。更新契約は[Provider Model Discovery](model-catalog.md)を参照する。V6 schema更新では`model_catalog_models`、`model_catalog_providers`、`model_catalog_revisions`を削除する。公開済みSessionの`catalog_revision`列の保存値は保持するが、実行設定の検証には使わず、Session、会話、draft、最小turnをcatalog変更で移行しない。

V6 schema更新は`character_affect_turn_settlements`を`DROP TABLE IF EXISTS`で削除する。旧queueのpending、評価候補、retry、実行中、quarantineは再開せず、本文・候補も除去する。旧storage constructorや中断回収を起動せず、再実行・再起動でも旧評価を送信しない。破棄を評価成功として扱わず、保存済みAffect event／関連episode／一般Memoryとversion・idempotency情報は保持する。一部保存済みや保存結果不明の候補も再適用しない。

`resolveOrMigrateAppDatabasePath`は、既存のvalid V6を優先し、必要ならV4の継続データをV6へ取り込む。V6がない場合は、存在するvalid sourceに応じてV4→V6、V3→V4→V6、V2→V3→V4→V6、V1→V2→V3→V4→V6の経路を使う。sourceにないDBを選んで上書きせず、未対応の新しいV4 schemaを旧版migrationで上書きしない。V6の継続対象と非対象は[V6 Database Foundation](v6-database-foundation.md)に記す。

各migrationのsource読取りは元DBのschema、row、journal modeと、共有blob・Character fileを変更しない。新しいV6 DBがinvalidなら、黙って置換しない。既存の空V6 DBとV4が共存する場合も継続データを移し、完了markerで再copyを防ぐ。migration実装は`src-electron/storage/migrations/`、既存データの選択は`app-database-path.ts`で確認する。

起動時の退役データcleanupは、管理対象のV6・移行元DB・backupからCompanion専用table／行、専有file・blob・SessionFolderと専用Git namespaceだけを対象とする。通常Session／最小turn、共有Memory／Affect本文、共有file・blob、target branch、他worktree、stashは保持する。退役Session由来の共有データはsource linkageを除去またはNULL化する。詳細な対象判定は`src-electron/storage/migrations/companion-removal.ts`と関連helperを正本とし、一般のDB resetやmigrationによるユーザーデータの無断破棄へ拡張しない。
