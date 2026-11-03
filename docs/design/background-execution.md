# Background Execution

## 共通基盤の責務

`BackgroundExecutionService`は呼出しごとの背景実行の寿命を所有する。`BackgroundCallService.runOnce()`はこのserviceへ実行を委譲し、注入されたAgent portを一度呼ぶ。三用途は`character-memory`、`target-memory`、`affect`であり、通常Session・Auxiliaryの実行状態・threadを書き換えない。

`AgentRuntimeBindingRegistry.issueBackground()`は呼出しごとの新規binding IDを発行する。actorSessionIdは元の実Sessionで、背景Providerは元SessionのProviderと独立する。通常bindingの再利用indexへ背景を入れず、通常turnの次回開始と相互に置換しない。

sourceは既存`isReadOnlySession`の対象とcharacter-authoringを除外する。開始時に実SessionとscopeのSession／incarnation／Characterを照合する。主会話のCancelと通常Window closeは背景取消へ接続しない。

背景の同時数にアプリ独自の上限を設けず、同じ用途・同じ会話でも独立したbinding／handle／admissionで並行開始できる。`begin()`は開始した`BackgroundExecution`を直接返す。実行中mapは取消・失効・終了時cleanupに用い、一件の終了や取消で他の実行を終了しない。待機queue・代替の同時数制限・直列化・timer・第二の実行管理表は持たない。Mainはruntime開始成功で`start()`し、停止開始で`stop()`して実行中の権限を失効させる。

## 共通の単発呼出

正本は`src-electron/providers/background-call-service.ts`。`BackgroundCallInput`は次を受ける。

- `context`: 実Session、actorSessionId、authority snapshot、operation grants、scope、任意の背景signal。
- `selection`／`userInput`: 背景Provider／Modelと用途入力。元SessionのProvider／threadは変更しない。
- `onAdmitted`: 実行を開始した直後の同期callback。起動側の開始位置更新用であり、保存成功通知ではない。

`BackgroundAgentPort`は`BackgroundAgentInput`のsession・scope・selection・userInput・binding・handle・signalを受け、同一実行内のbound MCP／CLIで材料を読み、必要な登録を行う。`void | Promise<void>`で実行終了を伝え、保存用final schema／parser／後段save callbackは持たない。通常threadや暗黙のProvider履歴を材料の代用にしない。実Provider adapterは未接続である。

順序は`begin → onAdmitted → runAgent → finish`。Agent実行全体に同じ`RuntimeTurnAdmission`を適用する。完了・失敗・取消のいずれでもfinallyでfinishし、専用の保存phaseは設けない。実行中も通常turnを予約・終了せず、主会話を待機させない。

beginのsource／authority不備と停止runtimeは既存例外を保持し、callbackを呼ばない。事前取消・実行中取消は`canceled`、AgentまたはonAdmittedの失敗は`failed`、正常終了は`completed`を返す。これらは実行の結果であり、保存成功・保存件数・全件未保存を意味しない。自然文の完了宣言も保存成功の証明にしない。

## 登録と保存効果

保存は各tool呼出の用途検証から既存application／Workerへ進む。呼出単位の応答と保存効果はその登録契約に従う。後続の失敗・取消・結果不明でも先行確定分を戻さない。共通runOnceは保存結果を集計せず、件数台帳・receipt・全件atomic保存を持たない。

順序・鮮度・意味的重複・取りこぼしの完全保証は行わない。checkpoint、補償、自動再送、読取再照合、専用復旧を追加せず、不明な効果を成功や全件未保存へ変換しない。認可・正しいowner／target・失効後の未確定write拒否と既存データ保護は維持する。

## 履歴readの共通契約

正本は`src-shared/session/session-history-read-scope.ts`。

- sourceは実Session ID、runtime表示用incarnation、既存storage ownerIdentityを持つ。Auxiliaryは親Mainのidentityも保持する。
- ownerIdentityは既存`readConversationQuerySnapshot()`の値をそのまま使う。Auxiliaryではdraft incarnationを含む。createdAtだけから新しく組み立てない。draft本文の変更とdraft incarnationの変更は別である。
- 許可範囲はfromMessageSeqからthroughMessageSeqまでのinclusiveな固定範囲。背景のprocessing Turn範囲とは別であり、追加入力で自動拡大しない。
- purpose・Memory target・processing範囲は背景scope側だけに置く。読取本体は生成用途を必須としない。

`authorizeSessionHistoryRead()`はサーバーが選んだ具体的operationのgrantと、背景binding・current handle／capabilityを検証する。通常turn、別binding、失効handle、capability欠落を拒否する。元会話Providerと背景Providerの一致は要求せず、既存の通常Memory認可のProvider一致条件は変更しない。

返された`AuthorizedSessionHistoryRead`はread scopeとMain内部admissionだけを持つ。履歴Applicationは同じstorage read境界でsource ownerIdentityと要求seq／Turn／operation所属を検証し、取消・storage generation失効を確認して返す。`matchesSessionHistorySource()`はそのowner照合を共用する。binding・capability・共有buffer・runtime credentialを公開inputや結果へ追加しない。

## 接続と論理実行の寿命

共有`ManagedHttpMcpHost`は独立tokenをbinding・generation・handle・runtime ownerへ固定する。現在性確認にMemory固有grantを使わず、実操作ごとにgrantを検証する。

履歴factoryとtool→operation対応を`SessionHistoryMcpRegistration`で登録する。factoryは許可operationだけを登録し、hostも直接tools/callの操作grantを検証する。履歴専用endpointは背景だけに公開し、通常turnからは利用できない。背景接続には履歴とMemoryのendpointだけを許可し、Glossary／Session Graphを拒否する。Memory factoryは具体的read grantと接続済みの用途登録だけを公開する。

Provider builderは通常接続の既存3 endpointと、背景のsession-history／Memory endpointを分ける。Mainはruntime開始時に履歴の実factoryとtool→operation対応を登録し、認可resolverの共通scope・admissionをStorage Workerの履歴readへ渡す。factory未登録なら背景接続を拒否し、空の履歴成功へ置換しない。公開操作と配布CLIの契約は[Session History](session-history.md)を参照する。

Agent実行終了時の`finish()`は、既存実行管理からbinding・handle・admission・HTTP token・MCP endpointを閉じる。旧bound CLIと遅延readも拒否する。取消・source／親削除・runtime停止・背景Provider失効でも同じ権限を終了する。未確定writeは既存Workerの失効stateで拒否し、確定済みwriteは巻き戻さず、応答確認済みの効果を取消結果へ置換しない。

通常turn内の公開Memory／Affect操作は維持する。Memory二用途とAffectの用途検証を含む背景登録handlerはMain runtimeへ接続済みである。実Provider、本番起動・設定・通知、Auxiliary保存は未接続である。採用判断と適用範囲は[ADR035](../adr/035-background-execution-binding-and-history-scope.md#背景実行内のmcpcli直接登録)、通常の実行は[Provider Adapter](provider-adapter.md)に従う。

## 背景Memory read

read toolと操作grantの対応は`src-shared/agent-runtime/background-memory-read.ts`を正本とする。`memory.search`、`memory.list_entries`、`memory.get_entry`、`memory.list_tags`、`character_memory.search`と履歴4操作を維持し、MCPの直接tools/callと配布bound CLIも同じ認可へ通す。登録以外のwrite・移動・忘却・file取得／export・横断一覧・fallback・Graph／Glossaryは許可しない。

背景では実binding IDに結び付いたcurrent handle／capabilityを必須とし、元会話の実Characterとauthority snapshotを照合する。背景Providerは元会話と異なってよい。通常bindingのProvider一致条件は維持する。scopeの`memoryTargets`は実Characterと許可Projectからcanonical targetへ解決し、principalの`readTargets`で要求targetと照合する。空集合を全targetへ拡大せず、user-globalも明示captureされた場合だけ許可する。

一般MemoryとCharacter Memoryの検索は、このprincipalを既存Memory serviceからMemory Worker／storeへ渡す。`get_entry`は要求targetに加え実entryの保存targetも確認し、範囲外entryを空の成功へ変換しない。forgotten本文の通常read除外は維持する。遅延readは返却前にもadmissionを検証し、native完了・取消・失効後の本文を返さない。通常turnの確定済みwrite結果の扱いは変更しない。

## 用途限定の登録接続

`src-shared/agent-runtime/background-operations.ts`は、Affectを`character_affect.appraise`、Character Memoryを`character_memory.append_episode`、対象Memoryを`memory.append`へ限定する。registryは要求grantが広くても当該purpose以外を認可しない。

`src-electron/providers/background-registration.ts`の`BackgroundRegistration`をMemory runtimeへ注入する。`readMainSource`は実Worker読取、`handlers[purpose]`は用途入力・source参照を検証し既存applicationへ登録するtrusted adapterである。runtimeは同じ接続定義をHTTPとhostへ渡す。handler未接続ではMCPへ登録toolを公開せず、直接runtime／bound CLIも`details.backgroundRegistration = "not_connected"`の効果なし拒否とする。通常turnの登録handlerへfallbackしない。Mainは実Workerの`stores.session.readMainSource`に、`backgroundMemoryRegistrationHandlers`の二用途と`registerBackgroundAffect`を組み込む。

HTTP認可は実binding・元会話のCharacter・current handle／capabilityに加え、実MainのownerIdentity／incarnation／metadataを読取境界で照合する。source不存在、read-only、character-authoring、Auxiliary保存を拒否する。用途handlerにはcanonical body、scope、実Main source、principal、同じadmission、transportと既存Memory／Character serviceを渡す。用途側は必要な入力・保存済みsourceのprocessing所属を検証する。

Memory登録の保存先上限はcaptureした`scope.memoryTargets`から解決し、readTargetsとは別の`writeTargets`と`memory.append` permissionを、用途登録の認可後に設定する。Character Memoryは当該Character＋character scopeへ限定する。`MemoryV6Service.append`もwriteTargetsを照合し、read制限だけではwriteを許可しない。AffectはMemory append permissionを持たず、linked episodeを拒否する。対象Memoryのfile appendも拒否する。

登録は同じadmission内で用途handlerから既存application／Worker mutationへ進む。write結果へread用の返却前失効assertを適用せず、commit確認後の取消で成功応答を効果なしへ上書きしない。未確定writeの失効は既存保存境界が担う。Handler接続だけで本番生成・起動や用途検証の完成を意味しない。

## 内部Main source read

`V6StorageWorkerBundle.stores.session.readMainSource(scope: SessionHistoryReadScope)`は`MainSourceSnapshot | null`を返す内部async入口である。型の正本は`src-shared/session/main-source-snapshot.ts`。Mainの実テーブルと既存ownerIdentityを照合し、Session metadataと、固定inclusive seq範囲内にassistantMessageSeqを持つ複数の保存済みTurnを返す。phaseとcompletedAtは保存値を返し、未設定の時刻を現在時刻で補わない。用途側が保存対象の終端phase・時刻・processing所属を検証する。

削除・incarnation／owner不一致・未保存の末尾範囲はnull、Auxiliary scopeは拒否する。MainとAuxiliaryの同名IDを代用せず、Workerへ既存admission bufferを伝播する。公開履歴toolへ内部metadataを追加せず、Workerから用途applicationへ逆依存しない。用途保存との組立てや本番起動への配線は呼出側が所有する。

## Memory生成の純粋な用途契約

`src-shared/memory-recording/`は二用途の頻度と自然言語の用途入力を扱う。Provider、DB、timer、admission取得、保存処理は持たない。

`memory-recording-frequency.ts`は`character-memory`と`target-memory`に独立した既定5 Turn／idle 5分を提供する。設定validatorはTurn数を1以上の安全な整数、idle分数を正の有限値として検証し、不正値を既定値へ置換しない。`getMemoryRecordingTrigger`は呼出側がowner×用途ごとに渡す未開始の終端Turn件数・頻度・実行中状態・連続idle分数から、`none`／`turn_count`／`idle`だけを返す。0件は起動せず、N件以上は実行中でも件数条件を満たし、端数は実行中でなくT分idleのときだけ条件を満たす。実開始とその通知は共通の単発呼出が担う。本番の発火と未開始位置管理は未接続である。

## Memoryの登録本文と直接登録

`memory-registration-input.ts`の`MEMORY_REGISTRATION_PRESETS`は二用途の標準本文である。Character Memoryは観察事実とCharacterの受け取りを区別したepisode、対象Memoryは事実・合意・制約・好み・実行結果を許可対象へ登録する。欠落情報や不明な成否を補完せず、不要なら登録しない。

`buildMemoryRegistrationInput({ scope, materials, instructionText? })`は、`instructionText`が未設定なら用途のプリセット、設定済みなら空文字列も含めその本文だけを使う。固定プリセットとの合成や追加指示レイヤーはない。本文、アプリが確定したprocessing／history／許可Memory target、参照材料、既存MCP／CLIの利用説明を別の節へ組み立てる。本文の編集で実binding、保存先上限、権限は変わらない。

`src-electron/memory/background-memory-registration.ts`の`runBackgroundMemoryRegistration(calls, input)`は、編集本文と材料を受け取り、組み立てた入力を既存`BackgroundCallService.runOnce()`の`userInput`へ渡す入口である。同じAgent実行内で公開tool schemaの入力を使い、Character Memoryは`character_memory.append_episode`／CLI `character-memory-append-episode`、対象Memoryは`memory.append`／CLI `append`から登録する。設定永続化・編集UI、実Provider・本番自動起動は未接続である。

`backgroundMemoryRegistrationHandlers`の二handlerはMainのMemory runtimeへ組み込まれる。共通HTTP認可が確認した実Main snapshotについて、固定history範囲かつprocessing Turn範囲に属し、completed／failed／canceledとcompletedAt・assistantMessageSeqを持つ保存済みTurnがあることを確認する。登録単位の本文・tag・episodeの事実／受け取り等の入力検証は、既存`MemoryV6Service.append`／`CharacterContextApplicationService.appendEpisode`が担う。後者は同じMemory appendとWorkerへ進む。

公開登録入力へ用途専用の候補schemaや個別の根拠参照fieldを追加しない。記録内容と会話・操作結果の意味上の対応はAgentが判断し、本文の真偽や成功・失敗を用途handlerが証明するものではない。処理対象となる保存済みTurnの実在・範囲はコードで確認し、実行結果を確認する材料は許可された履歴readで取得する。

登録ごとの既存保存応答とAgent実行の終了を区別する。`completed`は保存件数や保存成功の宣言ではなく、登録なしでも成立する。後続の登録拒否・Agent失敗・取消・結果不明でも確定済み保存は残し、専用の後段保存、全件atomic化、補償・自動再送・台帳は持たない。失効後の未確定writeは同じadmissionを受ける既存Worker境界で拒否する。

## Affect登録入力とMain保存

`affect-composition.ts`の`AFFECT_COMPOSITION_INSTRUCTIONS`は、取得時点のCharacter定義・保存済み会話・既存Affectから必要な変化だけを`character_affect.appraise`で登録し、変化なしなら登録しない自然言語プリセットである。会話を基本材料とし、必要な操作結果だけを参照する。非公開内面の復元・診断、欠落情報の補完や、作業失敗から根拠のないユーザーへの敵意を構成しない。

`buildAffectCompositionInput({ instructionBody?, characterDefinition, currentAffect }, scope)`は、本文未設定時だけプリセットを選ぶ。設定済み本文は空文字列も含め単独で使い、プリセットや追加の固定方針を重ねない。実行scope、Character定義、既存Affect、既存toolの技術的な利用説明は別節へ置く。本文を解釈する禁止文parserは持たず、権限は共通runtimeが制約する。`runBackgroundAffectCall(calls, input)`はこの入力を既存`BackgroundCallService.runOnce`の`userInput`へ渡し、同じAgent実行内のtoolで登録する。設定永続化・編集UI・実Provider・自動発火は呼出側の未接続範囲である。

背景appraiseの候補はlayer・target・family・value・intensity・reason・evidenceと`sourceTurnId`だけを持つ。MCP／配布CLIは同じstrict候補schemaを公開する。`registerBackgroundAffect`はruntimeへ直接届いた入力も候補全体として再検証し、余剰field、memoryEpisode、空文字列、不正enum／数値／組合せを拒否する。時刻・保存key・schemaVersionをモデルから受け取らず、rootのexpectedVersionも受け取らない。通常turnのappraiseは従来の候補契約を使う。

共通HTTP認可が実Mainのowner／Character／incarnationと同じadmissionを確定し、handlerが実WorkerのsourceTurnIdの実在・許可history／processing所属・終端phase（completed／failed／canceled）・completedAtを検証する。schemaVersion、保存identity、Turnのcanonical UTC completedAt、新規保存keyはアプリが補う。targetType／targetIdは感情の対象であり保存ownerを選ばない。occurredAtは観測上の時刻であり、非公開内面の発生時刻を認定しない。取得時点と保存時点のAffect version／projection／定義revisionは比較しない。

handlerは既存`CharacterContextApplicationService.appraise`の応答をそのまま返す。保存は同じ`RuntimeTurnAdmission`内で`CharacterAffectService.recordAppraisal`から既存Memory Worker／storeへ進む。複数候補の途中失敗は既存appraiseの部分失敗と確認済みsaved prefixを返し、後続を呼ばない。呼出後の失敗・取消・効果不明でも確定済みeventは保持する。補償・自動再送・専用台帳・用途結果への写像は持たず、自然文finalは保存成功の根拠にしない。保存済みAffectは通常contextから利用する。

背景AffectはMemory append permissionを持たず、linked episodeと一般Memory書込を許可しない。通常appraise／correct／reset／contextとlinked episode、保存済みevent／episode／Memoryは維持する。Auxiliaryのowner／FK／context対応は含めない。
