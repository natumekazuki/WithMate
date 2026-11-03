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

`BackgroundAgentPort`は`BackgroundAgentInput`のsession・scope・selection・userInput・binding・handle・signalを受け、同一実行内のbound MCP／CLIで材料を読み、必要な登録を行う。`void | Promise<void>`で実行終了を伝え、保存用final schema／parser／後段save callbackは持たない。通常threadや暗黙のProvider履歴を材料の代用にしない。実Providerへの接続は[本番共通runtimeとProvider](#本番共通runtimeとprovider)に従う。

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

通常turn内の公開Memory／Affect操作は維持する。Memory二用途とAffectの用途検証を含む背景登録handler、共通設定・Provider port・保存後通知はMain runtimeへ接続済みである。Memory二用途はcontrollerによる本番自動発火とAuxiliary登録へ接続済みである。Affect側の自動発火・Auxiliary保存は未接続である。採用判断と適用範囲は[ADR035](../adr/035-background-execution-binding-and-history-scope.md#背景実行内のmcpcli直接登録)、通常の実行は[Provider Adapter](provider-adapter.md)に従う。

## 背景Memory read

read toolと操作grantの対応は`src-shared/agent-runtime/background-memory-read.ts`を正本とする。`memory.search`、`memory.list_entries`、`memory.get_entry`、`memory.list_tags`、`character_memory.search`と履歴4操作を維持し、MCPの直接tools/callと配布bound CLIも同じ認可へ通す。登録以外のwrite・移動・忘却・file取得／export・横断一覧・fallback・Graph／Glossaryは許可しない。

背景では実binding IDに結び付いたcurrent handle／capabilityを必須とし、元会話の実Characterとauthority snapshotを照合する。背景Providerは元会話と異なってよい。通常bindingのProvider一致条件は維持する。scopeの`memoryTargets`は実Characterと許可Projectからcanonical targetへ解決し、principalの`readTargets`で要求targetと照合する。空集合を全targetへ拡大せず、user-globalも明示captureされた場合だけ許可する。

一般MemoryとCharacter Memoryの検索は、このprincipalを既存Memory serviceからMemory Worker／storeへ渡す。`get_entry`は要求targetに加え実entryの保存targetも確認し、範囲外entryを空の成功へ変換しない。forgotten本文の通常read除外は維持する。遅延readは返却前にもadmissionを検証し、native完了・取消・失効後の本文を返さない。通常turnの確定済みwrite結果の扱いは変更しない。

## 用途限定の登録接続

`src-shared/agent-runtime/background-operations.ts`は、Affectを`character_affect.appraise`、Character Memoryを`character_memory.append_episode`、対象Memoryを`memory.append`へ限定する。registryは要求grantが広くても当該purpose以外を認可しない。

`src-electron/providers/background-registration.ts`の`BackgroundRegistration`をMemory runtimeへ注入する。`readBackgroundSource`は実Worker読取、`handlers[purpose]`は用途入力・source参照を検証し既存applicationへ登録するtrusted adapter、`sourceKinds[purpose]`はその用途が対応する会話kindである。runtimeは同じ接続定義をHTTPとhostへ渡す。handler未接続またはsource kind未対応ではMCPへ登録toolを公開せず、直接runtime／bound CLIも効果なし拒否とする。通常turnの登録handlerへfallbackしない。Mainは実Workerの`stores.session.readBackgroundSource`と、`backgroundMemoryRegistrationHandlers`の二用途・`registerBackgroundAffect`を組み込み、Memory二用途の対応kindはMain／Auxiliary、AffectはMainに限定する。

HTTP認可は実binding・元会話のCharacter・current handle／capabilityに加え、実sourceのownerIdentity／incarnation／metadataを読取境界で照合する。source不存在、read-only、character-authoring、用途が未対応の会話kindを拒否する。用途handlerにはcanonical body、scope、実source、principal、同じadmission、transportと既存Memory／Character serviceを渡す。用途側は必要な入力・保存済みsourceのprocessing所属を検証する。

Memory登録の保存先上限はcaptureした`scope.memoryTargets`から解決し、readTargetsとは別の`writeTargets`と`memory.append` permissionを、用途登録の認可後に設定する。Character Memoryは当該Character＋character scopeへ限定する。`MemoryV6Service.append`もwriteTargetsを照合し、read制限だけではwriteを許可しない。AffectはMemory append permissionを持たず、linked episodeを拒否する。対象Memoryのfile appendも拒否する。

登録は同じadmission内で用途handlerから既存application／Worker mutationへ進む。write結果へread用の返却前失効assertを適用せず、commit確認後の取消で成功応答を効果なしへ上書きしない。未確定writeの失効は既存保存境界が担う。Handler接続だけで本番生成・起動や用途検証の完成を意味しない。

## 内部Background source read

`V6StorageWorkerBundle.stores.session.captureBackgroundSource(ref: BackgroundSourceRef)`は、実Main／Auxiliaryのmetadataと既存ownerIdentityを照合し、保存済み末尾で固定したinclusive historyと`BackgroundSourceSnapshot`を返す。`readBackgroundSource(scope: SessionHistoryReadScope)`は同じ共通経路で固定scopeを再検証する。型の正本は`src-shared/session/background-source-snapshot.ts`。metadataと、固定seq範囲内にassistantMessageSeqを持つ保存済みTurnを返し、phaseとcompletedAtを補完しない。用途側が保存対象の終端phase・時刻・processing所属を検証する。

削除・incarnation／owner／親identity不一致・未保存の末尾範囲はnullとする。MainとAuxiliaryの同名IDをkindで区別し、Auxiliaryのmetadata IDとdraft incarnationを親Mainへ代用しない。Turnの保存owner列も保持し、Auxiliaryでは`sessionId: null`と実`auxiliarySessionId`を返す。Workerへ既存admission bufferを伝播する。公開履歴toolへ内部metadataを追加せず、Workerから用途applicationへ逆依存しない。共通source読取は用途handlerのAuxiliary保存対応を保証しない。

## 本番共通runtimeとProvider

`BackgroundProductionRuntime`は`prepare()`で用途設定・Provider／model・source kind・実sourceを確認し、`buildBackgroundExecutionScope()`で固定historyとcontroller指定のprocessing末尾を組み立てる。`ready`にcall context・selection・編集本文を返し、`not_configured`・`unavailable`・取得の`failed`を区別する。本文はMemoryの`instructionText`、Affectの`instructionBody`へ渡す。`calls`は同じ共通単発呼出であり、用途の発火判断・未開始位置・保存結果を所有しない。

Mainは`createBackgroundProviderAgent()`をこのruntimeへ接続する。対応はClaudeのcatalog実modelのみとし、他Providerは利用不可とする。Claude SDKのbuilt-in tools・skills・plugins・filesystem settings・hooks・自動Memory・cloud connectorを無効化し、strict MCPで同じ実行の履歴／Memory endpointだけを渡す。本文のslash／file展開も無効化する。native managed設定およびカスタムendpoint／認証方式の構成は実行前に拒否し、通常設定へfallbackしない。機械制限は自然言語の禁止指示に依存しない。

通常のcoding adapter・thread・run stateは再利用せず、既存Claude SDK・binary解決・認証とmanaged MCP builderを利用する。背景出力は消費して破棄し、登録本文へCharacterのpersonaを二重注入しない。取消はnative processのcleanupまで待ち、Agent終端で共通寿命を閉じる。fake SDKによる接続検証と実認証の推論確認は区別する。

## 共通設定と用途controllerへの通知

`AppSettings.backgroundExecutionSettings`は三用途別の`selection?: { providerId, modelId }`と`instructionText?: string`を持つ。初期selectionは未設定で、既存Providerが有効かつ対応modelを取得できる用途だけ開始できる。本文未設定時だけ用途presetを使い、空文字列を含む編集本文はそのまま使う。別の追加指示レイヤーは持たない。`memoryRecordingFrequencies`は既存二用途の各5 Turn／idle 5分を既定とし、欠落時だけ初期化する。不正値は保存・読込境界で拒否する。既存AppSettings保存／変更通知とSettings編集へ接続し、通常会話の選択は変更しない。

`SessionRuntimeService.onBackgroundEvent`は開始保存後の`run_state`と、終端保存成功後の`terminal_saved`を送る。completed／failed／canceledをすべて含み、保存失敗からterminal発火しない。Main／Auxiliaryのassemblyはこの接点を共通runtimeへ渡し、`subscribe()`の用途controllerへsource ref付きで公開する。設定変更とruntime停止も同じ接点で通知する。同期throw・非同期rejectを隔離し、subscriberのPromiseを通常turnの保存・終了待ちへ加えない。OS通知の設定やcanceled除外は発火の条件にしない。

Memory二用途のcontrollerはこの購読接点へ接続されている。Affect側のcontroller・Auxiliary保存とは別の接続範囲である。背景実行の完了をMemory保存成功や通常turnのOS通知へ変換しない。

## Memoryの自動発火と開始位置

`MemoryRecordingController`はMainでruntime開始後に購読を開始し、`terminal_saved`／`run_state`／`settings_changed`を受ける。停止で購読・one-shot timer・用途状態を解放し、再開始で再購読する。削除・会話identity変更の既存Main／Auxiliary lifecycle接点でも当該sourceと配下の状態を解放する。Window closeや主会話だけのCancelを背景取消へ結び付けない。

状態は実source kind＋IDとincarnation・親identityで区別し、Mainと同名Auxiliary、各Auxiliary、二用途の開始位置を分離する。初回の会話開始通知では、保存済みuser messageの位置までを基準に既存Workerの`captureBackgroundSource`から現在の終端位置を得る。最初にterminal通知を受けた場合はそのTurnより前だけを初期位置とし、通知された新規Turnを捨てない。停止・再起動前の過去を一括処理しない。

未開始末尾より後の保存済みcompleted／failed／canceledを実件数で数え、既存`getMemoryRecordingTrigger`で0件は起動せず、N件以上は件数条件、端数は会話終了後の連続idleで起動する。IDの差分・stream・tool回数は件数にしない。会話開始でidleを解除し、終了・新規terminalと設定変更で必要なone-shot timerだけを再計算する。準備中の新規イベントも開始前に再評価し、会話再開前のidle条件で開始しない。固定周期pollingは持たない。

二用途ごとに未開始範囲の準備をまとめ、Agent終了は待たない。同じ用途の先行実行が遅くても新規範囲は別bindingで並行開始する。実行範囲・設定選択・本文は開始ごとに固定し、`runOnce.onAdmitted`の同期callbackだけで開始末尾を進める。準備・begin失敗で進めず、開始後の失敗・取消で戻さない。これは保存成功checkpointではなく、永続化・失敗待ちqueue・自動再送はない。

controllerは既存authorityの実Character targetと、対象Memoryでは許可Project targetを明示captureする。user-globalは推測で追加しない。共通runtimeの`prepare`が固定historyと指定processingを分けて組み立て、`runBackgroundMemoryRegistration`へ編集本文を渡す。材料の取得方法は技術情報として本文と分離する。未設定・利用不可・取得失敗は開始成功へ変換せず、未開始分を保ったまま次の会話・設定イベントで再評価する。設定変更は開始済み実行を再構成しない。

## Memory生成の純粋な用途契約

`src-shared/memory-recording/`は二用途の頻度と自然言語の用途入力を扱う。Provider、DB、timer、admission取得、保存処理は持たない。

`memory-recording-frequency.ts`は`character-memory`と`target-memory`に独立した既定5 Turn／idle 5分を提供する。設定validatorはTurn数を1以上の安全な整数、idle分数を正の有限値として検証し、不正値を既定値へ置換しない。`getMemoryRecordingTrigger`は呼出側がowner×用途ごとに渡す未開始の終端Turn件数・頻度・実行中状態・連続idle分数から、`none`／`turn_count`／`idle`だけを返す。0件は起動せず、N件以上は実行中でも件数条件を満たし、端数は実行中でなくT分idleのときだけ条件を満たす。実開始とその通知は共通の単発呼出が担う。本番の発火と未開始位置はMemory controllerが管理する。

## Memoryの登録本文と直接登録

`memory-registration-input.ts`の`MEMORY_REGISTRATION_PRESETS`は二用途の標準本文である。Character Memoryは観察事実とCharacterの受け取りを区別したepisode、対象Memoryは事実・合意・制約・好み・実行結果を許可対象へ登録する。欠落情報や不明な成否を補完せず、不要なら登録しない。

`buildMemoryRegistrationInput({ scope, materials, instructionText? })`は、`instructionText`が未設定なら用途のプリセット、設定済みなら空文字列も含めその本文だけを使う。固定プリセットとの合成や追加指示レイヤーはない。本文、アプリが確定したprocessing／history／許可Memory target、参照材料、既存MCP／CLIの利用説明を別の節へ組み立てる。本文の編集で実binding、保存先上限、権限は変わらない。

`src-electron/memory/background-memory-registration.ts`の`runBackgroundMemoryRegistration(calls, input)`は、編集本文と材料を受け取り、組み立てた入力を既存`BackgroundCallService.runOnce()`の`userInput`へ渡す入口である。同じAgent実行内で公開tool schemaの入力を使い、Character Memoryは`character_memory.append_episode`／CLI `character-memory-append-episode`、対象Memoryは`memory.append`／CLI `append`から登録する。設定・実Providerへの共通接点は本番runtimeを利用し、用途controllerから自動起動・未開始位置管理へ接続されている。

`backgroundMemoryRegistrationHandlers`の二handlerはMainのMemory runtimeへ組み込まれる。共通HTTP認可が確認した実Main／Auxiliary snapshotについて、固定history範囲かつprocessing Turn範囲に属し、completed／failed／canceledとcompletedAt・assistantMessageSeqを持つ保存済みTurnがあることを確認する。登録単位の本文・tag・episodeの事実／受け取り等の入力検証は、既存`MemoryV6Service.append`／`CharacterContextApplicationService.appendEpisode`が担う。後者は同じMemory appendとWorkerへ進む。AuxiliaryのTurnはsessionIdがnullで実auxiliarySessionIdを持つことを確認し、親Mainへ代用しない。出典はMain用sessionIdとAuxiliary用auxiliarySessionIdを分離して既存Memoryへ保存する。

公開登録入力へ用途専用の候補schemaや個別の根拠参照fieldを追加しない。記録内容と会話・操作結果の意味上の対応はAgentが判断し、本文の真偽や成功・失敗を用途handlerが証明するものではない。処理対象となる保存済みTurnの実在・範囲はコードで確認し、実行結果を確認する材料は許可された履歴readで取得する。

登録ごとの既存保存応答とAgent実行の終了を区別する。`completed`は保存件数や保存成功の宣言ではなく、登録なしでも成立する。後続の登録拒否・Agent失敗・取消・結果不明でも確定済み保存は残し、専用の後段保存、全件atomic化、補償・自動再送・台帳は持たない。失効後の未確定writeは同じadmissionを受ける既存Worker境界で拒否する。

## Affect登録入力とMain保存

`affect-composition.ts`の`AFFECT_COMPOSITION_INSTRUCTIONS`は、取得時点のCharacter定義・保存済み会話・既存Affectから必要な変化だけを`character_affect.appraise`で登録し、変化なしなら登録しない自然言語プリセットである。会話を基本材料とし、必要な操作結果だけを参照する。非公開内面の復元・診断、欠落情報の補完や、作業失敗から根拠のないユーザーへの敵意を構成しない。

`buildAffectCompositionInput({ instructionBody?, characterDefinition, currentAffect }, scope)`は、本文未設定時だけプリセットを選ぶ。設定済み本文は空文字列も含め単独で使い、プリセットや追加の固定方針を重ねない。実行scope、Character定義、既存Affect、既存toolの技術的な利用説明は別節へ置く。本文を解釈する禁止文parserは持たず、権限は共通runtimeが制約する。`runBackgroundAffectCall(calls, input)`はこの入力を既存`BackgroundCallService.runOnce`の`userInput`へ渡し、同じAgent実行内のtoolで登録する。設定・実Providerは本番runtimeの共通接点を利用し、用途側の自動発火とAuxiliary保存は未接続である。

背景appraiseの候補はlayer・target・family・value・intensity・reason・evidenceと`sourceTurnId`だけを持つ。MCP／配布CLIは同じstrict候補schemaを公開する。`registerBackgroundAffect`はruntimeへ直接届いた入力も候補全体として再検証し、余剰field、memoryEpisode、空文字列、不正enum／数値／組合せを拒否する。時刻・保存key・schemaVersionをモデルから受け取らず、rootのexpectedVersionも受け取らない。通常turnのappraiseは従来の候補契約を使う。

共通HTTP認可が実Mainのowner／Character／incarnationと同じadmissionを確定し、handlerが実WorkerのsourceTurnIdの実在・許可history／processing所属・終端phase（completed／failed／canceled）・completedAtを検証する。schemaVersion、保存identity、Turnのcanonical UTC completedAt、新規保存keyはアプリが補う。targetType／targetIdは感情の対象であり保存ownerを選ばない。occurredAtは観測上の時刻であり、非公開内面の発生時刻を認定しない。取得時点と保存時点のAffect version／projection／定義revisionは比較しない。

handlerは既存`CharacterContextApplicationService.appraise`の応答をそのまま返す。保存は同じ`RuntimeTurnAdmission`内で`CharacterAffectService.recordAppraisal`から既存Memory Worker／storeへ進む。複数候補の途中失敗は既存appraiseの部分失敗と確認済みsaved prefixを返し、後続を呼ばない。呼出後の失敗・取消・効果不明でも確定済みeventは保持する。補償・自動再送・専用台帳・用途結果への写像は持たず、自然文finalは保存成功の根拠にしない。保存済みAffectは通常contextから利用する。

背景AffectはMemory append permissionを持たず、linked episodeと一般Memory書込を許可しない。通常appraise／correct／reset／contextとlinked episode、保存済みevent／episode／Memoryは維持する。Auxiliaryのowner／FK／context対応は含めない。
