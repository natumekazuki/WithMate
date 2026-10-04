# Database Schema

## 現行DBと正本

通常起動の保存先は `<userData>/withmate-v6.db`（`PRAGMA user_version = 6`）である。V6のtable、column、index、foreign key、CHECKの実定義は`src-electron/storage/database-schema-v6.ts`を正本とする。起動時の選択とmigrationは`src-electron/storage/app-database-path.ts`、fresh DB作成と検証は`src-electron/storage/app-database-v6-bootstrap.ts`が担当する。

永続化データの正本と、Markdownやprovider instructionなどのgenerated projectionを混同しない。生成された投影は手編集を正本とせず、削除・忘却した情報を再投影やproviderへの送信に残さない。

V6 SQLiteの起動、schema更新、WAL maintenance、診断、通常の保存操作はstorage Workerが所有する。Mainは許可されたtyped commandを非同期で送る。close、reset、reopen後に旧storage generationの遅延応答を新しいDBへ適用しない。

## Storage Overview

| 領域 | 主な正本 |
| --- | --- |
| 設定・catalog | `app_settings`、`prompt_templates`、`model_catalog_*`、`characters` |
| Project | `project_scopes_v6` |
| Main Session | `sessions_v6`、`session_messages_v6` |
| Files Pin | `session_file_pins_v6` |
| Auxiliary | `auxiliary_sessions`、`auxiliary_session_messages`、`auxiliary_session_drafts` |
| Turn・監査 | `session_turns_v6`、`session_turn_interims_v6`、`session_turn_provider_outputs_v6` |
| Memory | `memory_*_v6` |
| Character Affect | `character_affect_*_v6`、turn settlement |

Mainの`sessions_v6.incarnation_id`は同じSession IDの削除・再作成を区別する。既存行限定の更新とAffect owner検証はIDだけでなくincarnationを照合する。Auxiliaryは親Sessionに従属し、metadataと順序付きmessage行、artifact詳細を分離する。独立draftの正本は`auxiliary_session_drafts`であり、一覧の最終使用順には会話更新時刻とdraft更新時刻の新しい方を使う。詳細は[Auxiliary Session](auxiliary-session.md)を参照する。

turnはMainまたはAuxiliaryの一方だけをownerとし、terminal marker、interim、provider outputを別tableへ保存する。Session表示に必要な軽量messageと重いartifact detailも分け、detailは対象を開いたときに取得する。通常turnと監査の契約は[Session Run Lifecycle](session-run-lifecycle.md)と[Audit Log](audit-log.md)を参照する。

会話の表示用readはmetadataと最新60件を返し、過去の本文は60件単位で取得する。messageの`historyIndex`は保存行の`seq`で、`messageCount`は会話全体の件数である。Mainの表示metadataは末尾pageより前にある場合も最新user messageを保持する。全履歴検索とmessage navigatorはstorage Workerで軽量messageを逐次投影し、本文の全件転送・常駐を要求しない。表示pageは保存用full Sessionとは区別し、storageの全文保存入口はpageを拒否する。rendererのmetadata更新はincarnationを照合した最新保存履歴へ適用し、paged本文で履歴を置換しない。runtimeとLLM contextのfull readは別経路のまま保持する。

Memoryのowner、scope、忘却、idempotency、保護対象fileは[V6 Memory Foundation](v6-memory-foundation.md)と[V6 Memory Protected Objects](v6-memory-protected-objects.md)を参照する。Characterの定義fileは`<userData>/characters/<character-id>/`に置き、catalog metadataとsession snapshotの境界は[Character Storage](character-storage.md)を参照する。

## Files Pin

`session_file_pins_v6`は親Sessionごとにroot種別、正規化root path、相対path、対象種類、root表示名を保持する。MainとAuxiliaryは同じ親SessionのPinを使い、アクセス時にはそれぞれの現在root認可を適用する。親Sessionへのforeign keyは`ON DELETE CASCADE`で、削除時にPinも削除する。新規・既存V6のschema更新はstorage Worker内の`ensureV6Schema`が行い、Session本文等を作り直さない。

root種別・root path・相対pathの識別keyを親Session内で一意にし、包含rootは別scopeとして扱う。Windowsではpathの識別をcase-insensitiveとし、相対pathの表示casingは保持する。Pinはpathへの目印で、rename追跡や内容固定を行わない。不存在・認可外でも参照を自動削除せず、一覧の利用不可状態と明示解除で扱う。

list／追加／解除は既存のtyped IPCからstorage Workerへ渡し、親Session IDとincarnationを確認する。解除はrootが除去済みでも可能だが、別親SessionのPinは変更しない。本文読込・全件index・追加watcherは用いず、登録先のmetadata確認を最大4件ずつ並列実行する。保存結果不明・取得失敗はエラーとして伝え、空のPin集合へfallbackしない。

## 起動時の移行とデータ保護

`resolveOrMigrateAppDatabasePath`は、既存のvalid V6を優先し、必要ならV4の継続データをV6へ取り込む。V6がない場合は、存在するvalid sourceに応じてV4→V6、V3→V4→V6、V2→V3→V4→V6、V1→V2→V3→V4→V6の経路を使う。sourceにないDBを選んで上書きせず、未対応の新しいV4 schemaを旧版migrationで上書きしない。V6の継続対象と非対象は[V6 Database Foundation](v6-database-foundation.md)に記す。

各migrationのsource読取りは元DBのschema、row、journal modeと、共有blob・Character fileを変更しない。新しいV6 DBがinvalidなら、黙って置換しない。既存の空V6 DBとV4が共存する場合も継続データを移し、完了markerで再copyを防ぐ。migration実装は`src-electron/storage/migrations/`、既存データの選択は`app-database-path.ts`で確認する。

起動時の退役データcleanupは、管理対象のV6・移行元DB・backupからCompanion専用table／行、専有file・blob・SessionFolderと専用Git namespaceだけを対象とする。通常Session／Audit、共有Memory／Affect本文、共有file・blob、target branch、他worktree、stashは保持する。退役Session由来の共有データはsource linkageを除去またはNULL化する。詳細な対象判定は`src-electron/storage/migrations/companion-removal.ts`と関連helperを正本とし、一般のDB resetやmigrationによるユーザーデータの無断破棄へ拡張しない。
