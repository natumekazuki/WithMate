# Database Schema

## 現行DBと正本

通常起動の保存先は `<userData>/withmate-v6.db`（`PRAGMA user_version = 6`）である。V6のtable、column、index、foreign key、CHECKの実定義は`src-electron/storage/database-schema-v6.ts`を正本とする。起動時の選択とmigrationは`src-electron/storage/app-database-path.ts`、fresh DB作成と検証は`src-electron/storage/app-database-v6-bootstrap.ts`が担当する。

永続化データの正本と、Markdownやprovider instructionなどのgenerated projectionを混同しない。生成された投影は手編集を正本とせず、削除・忘却した情報を再投影やproviderへの送信に残さない。

V6 SQLiteの起動、schema更新、WAL maintenance、診断、通常の保存操作はstorage Workerが所有する。Mainは許可されたtyped commandを非同期で送る。close、reset、reopen後に旧storage generationの遅延応答を新しいDBへ適用しない。

## Storage Overview

通常Sessionの端末共通運用設定は、`app_settings`の`session_selection_policy_json`（選定基準・実行設定の目安・順序付き契約経路）と`worktree_policy_json`（root・Git common directoryごとの配置ルール）に保存する。Storage Workerのtyped commandだけで更新し、未設定の読取で値を生成しない。通常の設定保存では保持し、設定全体resetでは解除する。実測quota、認証情報、Session実行設定とは独立し、schema migrationは追加しない。公開操作は[Sessionの選定方針とWorktree配置](../features/session-operating-policies.md)を参照する。

| 領域 | 主な正本 |
| --- | --- |
| 設定・catalog | `app_settings`、`prompt_templates`、`provider_model_cache`、`characters` |
| Project | `project_scopes_v6` |
| Main Session | `sessions_v6`、`session_messages_v6` |
| Turn Queue | `session_turn_queue_v6` |
| Files Pin | `session_file_pins_v6` |
| Session Graph | `session_graphs_v6`、`session_graph_topics_v6`、`session_graph_records_v6`、`session_graph_relations_v6` |
| Coordination | `coordination_records_v7` |
| Local Pull Requests | `local_prs_v7`、`local_pr_versions_v7`、`local_pr_comments_v7` |
| Auxiliary | `auxiliary_sessions`、`auxiliary_session_messages`、`auxiliary_session_drafts` |
| Turn | `session_turns_v6` |

Mainの`sessions_v6.incarnation_id`は同じSession IDの削除・再作成を区別する。既存行限定の更新はIDだけでなくincarnationを照合する。Auxiliaryは親Sessionに従属し、metadataと順序付きmessage行、artifact詳細を分離する。独立draftの正本は`auxiliary_session_drafts`であり、一覧の最終使用順には会話更新時刻とdraft更新時刻の新しい方を使う。詳細は[Auxiliary Session](auxiliary-session.md)を参照する。

turnはMainまたはAuxiliaryの一方だけをownerとし、phase、実行設定、message位置、thread、時刻、error summaryを`session_turns_v6`へ保存する。会話本文と操作結果の正本は通常履歴と`MessageArtifact.operationTimeline`であり、軽量messageと重いartifact detailを分け、detailは対象を開いたときに取得する。開始と終端の最小turn保存、取消・失敗判定、Timingとの関連付けは[Session Run Lifecycle](session-run-lifecycle.md)を参照する。

失敗したassistant messageは生成本文`text`と失敗理由`runFailure`を分けてJSONへ保存する。本文に通知を含む既存の保存データは、同ownerのfailed turnとassistant message位置・error summaryが一致する通知末尾だけを読取時に分離する。生成本文に似た文字列があるだけでは失敗と判定せず、保存済みの本文・artifact・bookmarkは破壊しない。全件・page・会話queryで同じ本文投影を使用する。

質問formの記録は通常assistant messageの`elicitationRecords`へ保存し、Main／Auxiliaryの表示pageにも含める。質問文・選択肢・form回答状態に加え、質問種別と本文内の位置`textRange`を保持する。通常質問について送信された選択肢の位置と秘密でない自由回答を保持する。秘密値・一般formの入力値・未送信の既定値や再操作用のlive requestは保存しない。範囲を持つ質問は元の本文に含まれ、長さ0の範囲は本文を持たない質問の挿入位置を表す。位置のない既存記録は本文の後ろに表示する。保存されたpending状態は失効済みとして読み、古い要求を復元しない。既存message JSONの任意fieldを使い、別tableや質問専用の永続queueは持たない。

通常Session送信の`accepted_json.origin.requestedExecutionOptions`は送信時の明示設定（省略項目を除く）を保持する。省略を解決した実効設定は既存の`accepted_json.request.executionOptions`へ格納し、同一request IDの照合には両方を使う。既存行に指定情報がない場合は補完せず、保存済み受付・結果を従来どおり読み取る。専用tableやschema migrationは追加しない。

親からの直接Steerは、子の既存user message JSONの`turnInput`へ対象WithMate Turn・native Turn・配送状態・添付と`origin`を保存する。originは実親のSession／incarnation／送信元Turn、明示宛先と表示snapshotを持ち、`kind: session`・`operation: steer`としてGUI入力と区別する。Provider呼出前にpendingを保存し、受理と保存の確定でconfirmed、送信結果不明はunknown、未送信確定はnot-sentとする。保存済みconfirmedを後続の失敗で巻き戻さない。既存のTurn入力保存・終端待機を使い、専用receipt・table・migrationは追加しない。originのない既存入力へ現在の親情報を補記しない。

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
- 旧形式の明示解放時刻（既存receiptとの互換用。現在は後続実行の条件に使わない）

受付順の`sequence`は不変で履歴cursorにも使用し、並べ替え可能な`queue_position`を実行順の正本とする。新規受付と当該列を持たない既存DBの初期値はsequenceとする。

receiptのUUIDは受付時から終端後まで同じexecution identityである。新規受付は実actorの会話・incarnation・Turn、操作と明示宛先をoriginとして入力に含める。GUI入力はGUI起点として区別する。受付時入力は再試行照合元であり、編集と追加入力では変更しない。採用入力は通常dispatchとqueue経由Steerのclaimで本文・添付を一緒に固定し、Provider未呼出が確認されたqueued復帰でのみ固定を解除する。固定はProvider受信の証明ではない。原文・採用入力が保存されていない既存行はNULLのまま保持し、現在の入力から補わない。

失敗Turnの明示的な新規再実行は既存の受付JSONに元receipt・Turn・送信来歴を`retrySource`として保持する。新しい受付の`origin`はGUIであり、元の配送actorや実行設定を再使用しない。追加入力は新しい開始入力へ混ぜない。

送信側表示用の`source_display_position`は、受付時の送信元Turnのlive assistant本文のUTF-16位置を保持する。`source_display_verified`は確定本文が観測時の本文prefixを保持した場合だけ1にする。prefix自体はメモリで保持し、DBへ複製しない。受付の再試行比較には表示位置を含めず、初回受付の位置を維持する。未検証・未記録の履歴位置は不明とし、時刻や内容から推測しない。

Session送信の`origin.deliveryTiming`は`immediate`（省略時の既定）または`after_source_turn`である。後者も受付時にreceiptを永続化し、通常のqueued状態で保持する。dispatch／Steerのclaimは、受付originの正確な送信元Main・incarnation・Turnの保存済みphaseがcompleted／failed／canceledで、終端保存が確定したものだけを対象とする。未完了・不明・置換された送信元では開始しない。実行候補はこの条件を満たすqueued項目の実行順とし、終了待ちの項目だけで後続の即時送信を塞がない。sourceの終端保存と結果は既存Turnを正本とし、新しいtableや終了フラグを持たない。受付読取の`sourceTurnPhase`はその正本から投影し、dispatch時の終端phaseを採用originへ含める。受付時本文とoriginは変更しない。

保存済み終端と実行guardの解放は別である。取消grace後も元Provider処理が残る場合は、runtimeが保持する未解放のexact Turn IDをclaim／Steerの除外条件へ渡す。GUI／公開receiptの`sourceTurnPendingRelease`はこのruntime待機を表す一時的な投影で、DBへ複製しない。実解放で解除し、その後に始まった別Turnは以前の報告を止めない。

Sessionからの送信とCoordination配送のoriginには、受付時の送信元・宛先のSession名とCharacterのID・名前・icon参照を表示snapshotとして含める。snapshotは表示用であり、認可・navigationには実Session identityを使う。再試行や予定入力の編集で保存済みsnapshotを現在の名前・Characterへ付け替えず、snapshotのない既存originへ現在値を補記しない。

送信側の読取は、表示中の保存message seqを既存Turnへ一括解決し、送信actorのkind・Session・incarnation・Turnを完全一致させる。実行中は明示されたWithMate Turnだけを追加対象にし、Provider native IDや最新Turnから推測しない。通常送信とqueue経由Send Inputは`list_sent_deliveries`で不変の`accepted_json.origin`から読み、receiptの受付sequenceをcursorとする。直接Steerは`list_sent_steers`で宛先Mainの既存user messageの`turnInput.origin`から読み、保存message行IDをcursorとする。それぞれexpression indexを使い、独立したkeysetで最大20件ずつ本文全文を返す。直接Steerには正確な宛先message seqとpending／confirmed／unknown／not-sentを返し、receiptを生成しない。共通execution詳細は返却された宛先とreceiptまたはmessage seqから取得する。送信本文の別保存や会話messageの複製は行わず、origin未記録の直接入力は逆引きしない。

Main／Auxiliaryの対象owner・request IDをそれぞれ一意にし、親または対象Auxiliary削除でreceiptも削除する。receiptは通常messageとは別の受付・実行状態であり、会話本文やturnの正本を置換しない。受付・開始・終端のtransaction境界は[Electron Session Store](electron-session-store.md#turn-queue)を参照する。

通常受付と同時にclaimされた行は、`starting`と採用入力が揃った状態で初めて参照可能になる。実行枠を確保しなかった行は従来どおり`queued`として保存する。

会話の表示用readはmetadataと最新60件を返し、過去の本文は60件単位で取得する。messageの`historyIndex`は保存行の`seq`で、`messageCount`は会話全体の件数である。Mainの表示metadataは末尾pageより前にある場合も最新user messageを保持する。

表示pageは保存用full Sessionとは区別し、storageの全文保存入口はpageを拒否する。rendererのmetadata更新はincarnationを照合した最新保存履歴へ適用し、paged本文で履歴を置換しない。turn runtimeはmetadataと全体件数、当該turnで追加したmessageだけを保持し、開始・追加入力・終端を専用commandで追加する。履歴を必要とするconsumerのfull readは明示的な別経路で保持する。

全履歴検索とMessages navigatorは、storage ownerの短いindexed cursor batchと、DBを所有しないCPU Workerで処理する。検索のsourceは保存本文、previewはMarkdownの表示検索投影を使い、全件のmatch数、messageの`seq`、message内の`occurrenceIndex`を維持する。

結果は任意offsetから最大64件と総件数を返し、全本文・全matchの配列を転送・保持しない。Navigatorはuser／assistantだけを対象とし、Bookmarkを投影前に絞り、previewは最大160 Unicode codepointとする。

Navigatorに子スレッド等の所属範囲が指定された場合は、正本seqの短いbatchで対象本文だけを読む。発言元はbatch内のuser seqについて、Main／Auxiliaryのownerとincarnationを照合する。紐づき済みreceiptの部分indexを既存V6 DBにも起動時に追加し、本文・receipt・schema versionは変更しない。同じseqに複数receiptがある場合は受付sequenceが最後のreceiptを使い、採用入力を受付時入力より優先する。receiptがなければ本文内の直接Steerのoriginを使う。

継続pageはrequest ID、generation、会話owner、対象revisionを照合し、変更・取消・失効を成功0件と区別する。所有と取消・上限は[V6 Database Foundation](v6-database-foundation.md#runtime-ownerとschema)を参照する。

Characterの定義fileは`<userData>/characters/<character-id>/`に置き、catalog metadataとsession snapshotの境界は[Character Storage](character-storage.md)を参照する。

## Coordination

`coordination_records_v7`はCrew起点Mainをownerとし、起票元の実Main／Auxiliary identity・Turn、元依頼receiptと保存originの実呼出元、現在の回答担当、本文・選択肢、現在の回答とrevisionを保持する。回答担当の変更で起票元は変えない。参照は全Crewへ公開するが、更新権限は起票元・現在の担当・実ユーザーごとに検証する。実ユーザー回答はtrusted GUI入口に限る。

明示配送は通常の`session_turn_queue_v6`へ受付け、Coordinationとqueueの保存は同じWorker接続のtransaction内で行う。操作UUIDによる再試行照合は記録内の操作情報を用い、公開結果へは返さない。置き換えられた回答の本文はCoordination本体に残さず、その操作IDの再使用を拒否する。独立queue・outbox・台帳は持たない。訂正記録と訂正元の状態も同じtransactionで保存する。

回答は起票元が取得する前まで変更できる。変更時は未開始の旧回答配送を取り消し、新しい回答と配送を同じtransactionで保存する。配送開始中の変更は拒否し、配送状態の確認を求める。起票元のTurn入力が保存された時にその回答を取得済みにする。起票元のMCP／CLI操作が回答を返す場合も同じtransactionで取得済みにし、以後は保存側で回答の変更を拒否する。GUIや他Sessionの参照は取得済みにしない。取得済みは回答の利用や相談の解決を意味せず、明示consumeとresolveは別である。

Agent担当が未取得の回答をユーザーへ引き継ぐ場合は、その未開始配送と回答を取り消し、引継ぎ理由を現在の相談情報として示す。取得済みの回答は引継ぎで置き換えず、新しい相談として扱う。訂正された相談は現在の訂正先を参照できる。

関連Turnへの自動Steerは既存receiptの`input_turn_id`／`dispatched_json`とMain／AuxiliaryのSteer appendを使い、入力・回答取得・receipt完了を同じtransactionへ含める。新規受付の`coordination.targetKind`は正確な配送先種別を保持する。これを持たない既存receiptへ現在値を補記せず、通常queueで配送する。interruptedで結果不明の回答は修正や引継ぎでも置換しない。関係照合と再送防止は[Coordinationの関連Turn配送](session-run-lifecycle.md#coordinationの関連turn配送)に従い、別台帳やmigrationは追加しない。

取り下げと回答は併存する。取り下げは受理済み回答・queueを取消さず、未取得の有効な回答も受付ける。queueの本文は相談／回答の自然文とし、ID・回答revision・来歴・状態を持つ通知snapshotは既存captured入力の`coordination.notification`へ分離する。受付時入力を保ち、dispatch claim時に現在状態と取り下げ理由を採用通知へ追加する。Providerには本文と別の入力来歴contextで通知を渡す。通知JSONを本文に持つ既存受付も保存metadataで識別してdispatch時に分離し、受付原文と既存の保存会話は書き換えない。置き換えで取り消した受付も通常queueの受付記録として残る。Coordinationは既存Provider質問・承認やGUI Steerへ変換しない。

起票Turn終了・Window close・再起動で記録は失効しない。Crew削除は未対応記録の起票元・現在のAgent担当と通常queueの既存guardで判定し、成立したCrew全体削除ではCrew所有記録をcascade削除する。解決済みや取り下げ済みの相談もCrewが存続する間保持する。

詳細取得は起票元の保存identityから共通execution read用の`initiatorTarget`を投影する。Auxiliaryでは現在の親Main identityも同じ読取transactionで解決し、記録自身へ重複保存しない。存在しない記録・明示指定された削除済みCrew／Mainの照会は`COORDINATION_DELETED`としてGUIへ返す。通信失敗や認可失敗をこの終端結果へ変換せず、一時取得失敗と削除済み表示を区別する。

## Session Graph

Session Graphも親MainのID/incarnationを所有境界とし、Mainと配下Auxiliaryが共有する。親削除で全記録をcascade削除し、AuxiliaryのCloseでは消さない。構造・競合・MCP・表示の契約は[Session Graph](session-graph.md)を参照する。

起動時の`ensureV6Schema`は、`app_settings.session_graph_agent_origin_contract_initialized_at`が未設定の場合に全Session・全TopicのGraph専用4 tableの行をrevision・payloadごと初期化する。Graphの初期化とmarker保存は同じtransaction内で行い、Window／MCPの利用前に完了する。markerは設定リセットでも保持し、再呼出し・再起動では新しく保存したGraphを消さない。Session、会話・draft・turn、Character資産や参照先fileは初期化対象に含めず、旧Graphの変換・読取互換は提供しない。

Copilot／OpenCodeの明示Reviewerは、Mainでは `sessions_v6.runtime_policy_json.withMateReviewerExplicit`、Auxiliaryでは `auxiliary_sessions.withmate_reviewer_explicit` に保持する。旧データのマークなし／0は未指定であり、保存済みReviewerを明示したものと解釈しない。受付時に捕捉した値は後から書き換えない。

## Local Pull Requests

PR・提出版・コメント（GUI下書きを含む）・ApprovalはGit common directory単位でStorage Workerが保存する。作成元／投稿者のSession識別は履歴であり、Sessionの削除ではPRをcascade削除しない。既存V6 DBには専用テーブルを追加し、会話・設定・既存データの再作成は要求しない。

提出版の前後commitをGitオブジェクトとして維持し、branchの移動から独立させる。CI定義は提出commitの `.withmate/ci.yml` を正本とし、実行・ログは `<userData>/local-pr-ci/` で管理する。Session WindowやPR Windowの開閉だけで実行結果を変更しない。意図的にDBファイルを再作成する全対象ResetではDB上のPRも消えるが、GitオブジェクトやCI実行ファイルを同時に削除しない。

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

### Memory/Affect廃止と共有保存データの継続

Memory／Affectの専用データは、起動時のstorage更新で退避せず破棄する。fresh DBには専用table・設定を作成しない。除去対象の正本は`src-electron/storage/migrations/memory-affect-removal.ts`、起動接続は`app-database-path.ts`と`database-schema-v6.ts`、採用範囲と復元元は[ADR 036](../adr/036-memory-affect-removal.md)に記す。

専用V6 tableは次の15件である。保存本文・eventだけでなく、関連・tag・添付metadata・変更記録・idempotencyを一体で除去する。これに加え、旧queueの`character_affect_turn_settlements`も除去し、候補を再適用しない。

- Affect: `character_affect_observations_v6`、`character_affect_mutations_v6`、`character_affect_idempotency_v6`、`character_affect_resets_v6`、`character_affect_events_v6`
- Memory: `memory_entry_relations_v6`、`memory_entry_tags_v6`、`memory_idempotency_forget_results_v6`、`memory_idempotency_keys_v6`、`memory_move_events_v6`、`memory_mutation_events_v6`、`memory_protected_objects_v6`、`memory_target_tag_stats_v6`、`memory_tag_catalog_v6`、`memory_entries_v6`

`app_settings`から削除する専用keyは次の7件に限定し、他の設定行は保持する。

- `memory_generation_enabled`
- `memory_extraction_provider_settings_json`
- `mate_memory_generation_settings_json`
- `memory_file_quota_bytes`
- `character_affect_context_enabled`
- `memory_recording_frequencies_json`
- `background_execution_settings_json`

通常Main／Auxiliary、会話・artifact・最小turn、Session Graph、Coordination、Character catalog・定義・snapshot、`project_scopes_v6`、Prompt Templateと共有file／blobは専用破棄の対象外である。元取込file、利用者export（SessionFolder内の`memory-exports/`も含む）、V4 sourceは保持し、破棄済み専用データの再取込元にはしない。製品外のルール・設定・既設CLI登録は清掃しない。再実行では削除済みの専用table・設定・fileを再作成しない。

### 専用データ破棄のfilesystem境界

file除去はmanaged userData配下の`memory-objects/v6/`全体（`.staging/`を含む）と`memory-keys/v6-keyring.json`だけを対象とする。親の`memory-objects/`・`memory-keys/`全体、共有file、元取込file、exportを削除対象へ広げない。

userData、対象までの祖先、対象とその配下を`lstat`／`realpath`で検査し、包含範囲外、symlink／junction、想定外のfile種別を拒否する。payload treeとkeyringの事前検査を終えてから削除し、削除直前にも検査する。対象が既に存在しない場合は除去不要として扱う。既存V6 DBも、schema変更前にDB fileと祖先がlink経由でないことを確認する。この検査は外部参照を辿って削除する許可ではない。

### 起動更新の失敗とデータ保護

DBの専用table・設定除去は既存`ensure_v6_schema` savepoint内で行い、foreign keyを無効化せず、失敗したschema更新をrollbackして例外を返す。専用tableが存在する既存V6の更新失敗を、V4からの置換や空DB作成による起動成功へ変換しない。file検査・削除の失敗も起動入口へ伝播し、破棄成功として起動を継続しない。

file除去とDB更新は一つのtransactionではない。file除去はschema更新より先に行われるため、後続DB更新の失敗で除去済みfileが復元される保証はない。file削除途中の失敗も全fileのrollbackとは扱わない。退避・自動復元・専用データの再生成による救済は行わず、障害解消後の再実行でも同じ限定された対象だけを処理する。

契約のsynthetic検証は`tests/main/memory-affect-removal.test.ts`で、本番起動storage入口による専用破棄・共有行保持・再実行、SQL失敗時のDB rollbackと起動拒否、link先非削除を確認する。これは稼働環境への適用・実データ破棄の完了を意味しない。

### 継続データの移行と退役データcleanup

`resolveOrMigrateAppDatabasePath`は、既存のvalid V6を優先し、必要ならV4の継続データをV6へ取り込む。V6がない場合は、存在するvalid sourceに応じてV4→V6、V3→V4→V6、V2→V3→V4→V6、V1→V2→V3→V4→V6の経路を使う。sourceにないDBを選んで上書きせず、未対応の新しいV4 schemaを旧版migrationで上書きしない。V6の継続対象と非対象は[V6 Database Foundation](v6-database-foundation.md)に記す。

各migrationのsource読取りは元DBのschema、row、journal modeと、共有blob・Character fileを変更しない。新しいV6 DBがinvalidなら、黙って置換しない。既存の空V6 DBとV4が共存する場合も継続データを移し、完了markerで再copyを防ぐ。migration実装は`src-electron/storage/migrations/`、既存データの選択は`app-database-path.ts`で確認する。

起動時の退役データcleanupは、管理対象のV6・移行元DB・backupからCompanion専用table／行、専有file・blob・SessionFolderと専用Git namespaceだけを対象とする。

通常Session／最小turn、共有file・blob、target branch、他worktree、stashは保持する。退役Session由来の共有データはsource linkageを除去またはNULL化する。

詳細な対象判定は`src-electron/storage/migrations/companion-removal.ts`と関連helperを正本とし、一般のDB resetやmigrationによるユーザーデータの無断破棄へ拡張しない。
