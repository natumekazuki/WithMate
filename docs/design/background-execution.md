# Background Execution

## 共通基盤の責務

`BackgroundExecutionService`は一回の背景実行と同時上限を所有する。`BackgroundCallService.runOnce()`はこのserviceへ実行を委譲し、注入されたAgent portを一度呼ぶ。三用途は`character-memory`、`target-memory`、`affect`であり、通常Session・Auxiliaryの実行状態・threadを書き換えない。

`AgentRuntimeBindingRegistry.issueBackground()`は呼出しごとの新規binding IDを発行する。actorSessionIdは元の実Sessionで、背景Providerは元SessionのProviderと独立する。通常bindingの再利用indexへ背景を入れず、通常turnの次回開始と相互に置換しない。

sourceは既存`isReadOnlySession`の対象とcharacter-authoringを除外する。開始時に実SessionとscopeのSession／incarnation／Characterを照合する。主会話のCancelと通常Window closeは背景取消へ接続しない。

背景全体3件、用途×conversation ownerIdentityごと1件までを保持する。満杯・同用途の実行中は明示的な起動見送りを返し、bindingを発行しない。永続queue・timer・第二の実行管理表は持たない。Mainはruntime開始成功で`start()`し、停止開始で`stop()`して実行中の権限を失効させる。

## 共通の単発呼出

正本は`src-electron/providers/background-call-service.ts`。`BackgroundCallInput`は次を受ける。

- `context`: 実Session、actorSessionId、authority snapshot、operation grants、scope、任意の背景signal。
- `selection`／`userInput`: 背景Provider／Modelと用途入力。元SessionのProvider／threadは変更しない。
- `onAdmitted`: 枠取得後の同期callback。起動側の開始位置更新用であり、保存成功通知ではない。

`BackgroundAgentPort`は`BackgroundAgentInput`のsession・scope・selection・userInput・binding・handle・signalを受け、同一実行内のbound MCP／CLIで材料を読み、必要な登録を行う。`void | Promise<void>`で実行終了を伝え、保存用final schema／parser／後段save callbackは持たない。通常threadや暗黙のProvider履歴を材料の代用にしない。実Provider adapterは未接続である。

順序は`begin → onAdmitted → runAgent → finish`。Agent実行全体に同じ`RuntimeTurnAdmission`を適用する。完了・失敗・取消のいずれでもfinallyでfinishし、専用の保存phaseは設けない。実行中も通常turnを予約・終了せず、主会話を待機させない。

capacity／already_activeは`skipped`でcallbackを呼ばない。beginのsource／authority不備と停止runtimeは既存例外を保持する。事前取消・実行中取消は`canceled`、AgentまたはonAdmittedの失敗は`failed`、正常終了は`completed`を返す。これらは実行の結果であり、保存成功・保存件数・全件未保存を意味しない。自然文の完了宣言も保存成功の証明にしない。

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

通常turn内の公開Memory／Affect操作は維持する。用途検証を含む背景登録handler、実Provider、本番起動・設定・通知、Auxiliary保存は未接続である。採用判断と適用範囲は[ADR035](../adr/035-background-execution-binding-and-history-scope.md#背景実行内のmcpcli直接登録)、通常の実行は[Provider Adapter](provider-adapter.md)に従う。

## 背景Memory read

read toolと操作grantの対応は`src-shared/agent-runtime/background-memory-read.ts`を正本とする。`memory.search`、`memory.list_entries`、`memory.get_entry`、`memory.list_tags`、`character_memory.search`と履歴4操作を維持し、MCPの直接tools/callと配布bound CLIも同じ認可へ通す。登録以外のwrite・移動・忘却・file取得／export・横断一覧・fallback・Graph／Glossaryは許可しない。

背景では実binding IDに結び付いたcurrent handle／capabilityを必須とし、元会話の実Characterとauthority snapshotを照合する。背景Providerは元会話と異なってよい。通常bindingのProvider一致条件は維持する。scopeの`memoryTargets`は実Characterと許可Projectからcanonical targetへ解決し、principalの`readTargets`で要求targetと照合する。空集合を全targetへ拡大せず、user-globalも明示captureされた場合だけ許可する。

一般MemoryとCharacter Memoryの検索は、このprincipalを既存Memory serviceからMemory Worker／storeへ渡す。`get_entry`は要求targetに加え実entryの保存targetも確認し、範囲外entryを空の成功へ変換しない。forgotten本文の通常read除外は維持する。遅延readは返却前にもadmissionを検証し、native完了・取消・失効後の本文を返さない。通常turnの確定済みwrite結果の扱いは変更しない。

## 用途限定の登録接続

`src-shared/agent-runtime/background-operations.ts`は、Affectを`character_affect.appraise`、Character Memoryを`character_memory.append_episode`、対象Memoryを`memory.append`へ限定する。registryは要求grantが広くても当該purpose以外を認可しない。

`src-electron/providers/background-registration.ts`の`BackgroundRegistration`をMemory runtimeへ注入する。`readMainSource`は実Worker読取、`handlers[purpose]`は用途入力・source参照を検証し既存applicationへ登録するtrusted adapterである。runtimeは同じ接続定義をHTTPとhostへ渡す。handler未接続ではMCPへ登録toolを公開せず、直接runtime／bound CLIも`details.backgroundRegistration = "not_connected"`の効果なし拒否とする。通常turnの登録handlerへfallbackしない。現在のMainは三用途のhandlerを登録していない。

HTTP認可は実binding・元会話のCharacter・current handle／capabilityに加え、実MainのownerIdentity／incarnation／metadataを読取境界で照合する。source不存在、read-only、character-authoring、Auxiliary保存を拒否する。用途handlerにはcanonical body、scope、実Main source、principal、同じadmission、transportと既存Memory／Character serviceを渡す。必要な候補値・source参照・processing所属・時刻などの検証は用途handlerが実装してから接続する。

Memory登録の保存先上限はcaptureした`scope.memoryTargets`から解決し、readTargetsとは別の`writeTargets`と`memory.append` permissionを、用途登録の認可後に設定する。Character Memoryは当該Character＋character scopeへ限定する。`MemoryV6Service.append`もwriteTargetsを照合し、read制限だけではwriteを許可しない。AffectはMemory append permissionを持たず、linked episodeを拒否する。対象Memoryのfile appendも拒否する。

登録は同じadmission内で用途handlerから既存application／Worker mutationへ進む。write結果へread用の返却前失効assertを適用せず、commit確認後の取消で成功応答を効果なしへ上書きしない。未確定writeの失効は既存保存境界が担う。Handler接続だけで本番生成・起動や用途検証の完成を意味しない。

## 内部Main source read

`V6StorageWorkerBundle.stores.session.readMainSource(scope: SessionHistoryReadScope)`は`MainSourceSnapshot | null`を返す内部async入口である。型の正本は`src-shared/session/main-source-snapshot.ts`。Mainの実テーブルと既存ownerIdentityを照合し、Session metadataと、固定inclusive seq範囲内にassistantMessageSeqを持つ複数の保存済みTurnを返す。phaseとcompletedAtは保存値を返し、未設定の時刻を現在時刻で補わない。用途側が保存対象の終端phase・時刻・processing所属を検証する。

削除・incarnation／owner不一致・未保存の末尾範囲はnull、Auxiliary scopeは拒否する。MainとAuxiliaryの同名IDを代用せず、Workerへ既存admission bufferを伝播する。公開履歴toolへ内部metadataを追加せず、Workerから用途applicationへ逆依存しない。用途保存との組立てや本番起動への配線は呼出側が所有する。

## Memory生成の純粋な用途契約

`src-shared/memory-recording/`は二用途の頻度と構造化候補を扱う。Provider、DB、timer、admission取得、保存処理は持たない。

`memory-recording-frequency.ts`は`character-memory`と`target-memory`に独立した既定5 Turn／idle 5分を提供する。設定validatorはTurn数を1以上の安全な整数、idle分数を正の有限値として検証し、不正値を既定値へ置換しない。`getMemoryRecordingTrigger`は呼出側がowner×用途ごとに渡す未開始の終端Turn件数・頻度・実行中状態・連続idle分数から、`none`／`turn_count`／`idle`だけを返す。0件は起動せず、N件以上は実行中でも件数条件を満たし、端数は実行中でなくT分idleのときだけ条件を満たす。全体上限や実開始は既存admissionの責務である。

`memory-recording-candidates.ts`は用途別schemaとvalidatorを提供する。候補ありは非空配列、候補なしは明示的な`no_candidates`だけを受け入れ、未知fieldや不正値を拒否する。Characterは既存episode型と事実／受け取りの区別、対象Memoryは既存kind・本文・tagと許可slotを使う。本文の制限・trim・tag正規化は通常Memory appendと同じ純粋validatorを共用する。

アプリは固定history範囲、参照可能な保存messageとそのprocessing所属、操作／checkのindexをcontextへ渡す。validatorは根拠の実在・範囲と候補ごとにprocessing根拠があることを確認する。`execution_result`には保存済みの操作またはcheck参照を必要とするが、成功・失敗・成否不明によって候補を拒否しない。実行結果の解釈と記録内容の意味判断は生成LLMに委ね、validatorに成否判定入力は持たせない。対象Memoryへ`character_interpretation`は保存候補として返さない。これは参照・値の検証であり、自然言語の真偽や同一性を証明するものではない。成否不明を成功へ補完しない等の生成指示や既存の保護境界を、validatorによる意味の完全保証へ置き換えない。

Characterの保存先はcontextの当該Character targetで固定し、対象Memoryはcontextのslot→targetだけを返す。モデル出力にowner、target tuple、権限、保存key等を受け付けない。contextはアプリが認可済みの実sourceから構成する内部入力であり、生成出力の自己申告から作らない。実owner／admissionの認可は接続側が担う。schemaは`z.toJSONSchema(schema, { io: "input" })`で生成用の構造schemaにでき、実在確認・正規化はvalidatorを通す。通常turnのMemory操作は変更せず、背景の内部保存入口からこのvalidatorを利用する。

## Memory候補のMain内部保存

`src-electron/memory/background-memory-application-service.ts`の`BackgroundMemoryApplicationService.apply(execution, final, context)`は、既存の同一`BackgroundExecution`を受け取るtrusted appの保存入口である。第二のbeginや独自の実行管理を持たず、finishも呼ばない。

この内部moduleは単体で保持されているが、共通runOnceやMCP／CLIの登録経路からは呼ばない。用途検証のtool境界への接続は未実装である。

`BackgroundMemoryContext`は許可read時にアプリが構成したfull `SessionHistoryReadScope`、processing Turn範囲、保存messageのseq・processing所属・操作/check index、slot→targetを持つ。historyとprocessingはregistryの実bindingのscopeと一致し、slotの全targetはその`memoryTargets`内でなければならない。モデルからcontextを構成しない。実行結果の成否や意味を判定する入力は不要である。

保存入口はregistryの実背景binding、current handle／capabilityと共有admission state、Memory用途、local-userとCharacterを確認する。注入される`readMainSource(history)`は実Main metadataと同じ保存読取境界で観測した既存ownerIdentityを返す。Main ID・incarnation・ownerIdentity・Characterを照合し、source不存在、read-only、character-authoring、Auxiliary、別executionや許可範囲を広げるcontextは保存前に拒否する。source readはアプリ所有portであり、モデル値や親Mainへの付け替えで代用しない。

final全体を既存二用途validatorで検証してから最初のwriteへ進む。CharacterはbindingのCharacter owner＋character scopeに固定し、既存`CharacterContextApplicationService.appendEpisode`のCharacter／Main scope検証からMemory appendへ進む。対象Memoryは許可slotを解決して既存`MemoryV6Service.append`へ進む。アプリが実binding由来の`session_binding` principal（memory.appendのみ）、schemaVersion、新規保存keyを補い、正規化済みtagを公開入力のtype/valueへ写像する。無条件のlocal-user principal、通常会話のwrite credential、新batch／別storeは使わない。Affect eventやlinked episodeは生成しない。

一候補ずつ`runWithRuntimeTurnAdmission(execution.admission)`で保存し、既存Memory Workerのmutationへ同じ共有失効stateを伝播する。実行中のadmissionを使い、実行失効後の未確定writeはWorkerでも拒否される。失効を実装するためのrevision/hash再照合や、本文の鮮度比較は行わない。

`BackgroundMemoryResult`は`no_candidates`、全件成功応答確認済みの`saved`、最初の拒否／失敗／取消／unknownで終了する`stopped`を区別する。確認済みprefixにはcandidateIndex・entryId・応答のcreated/replayedを残す。stoppedは停止候補index、error code・cause、当該保存のeffect（none／unknown）、未呼出indexを返す。候補配列を確定できない入力／権限拒否では停止indexと未呼出indexがnullになり得る。未呼出分は停止候補自体とは分ける。

serviceのErrorResponseとthrowを扱い、保存前拒否・未送信の`StorageWorkerGenerationError`・効果なしが確定したWorker拒否はnoneとする。送信後の効果が分からない場合はunknownとし、成功や全件未保存に置換しない。Character appendもMemory部分で既知の未送信／拒否をnoneとして保持する。最初の非成功後は後続保存・補償・read-reconcile・自動再送を行わない。取消後も確認済みprefixを巻き戻さない。

このmoduleは実Mainの既存保存契約だけを利用し、Auxiliaryの保存owner/FK対応は含まない。

## Affect候補とMain内部保存

`affect-composition.ts`の`validateAffectCompositionOutput(unknown)`は、外部finalのJSON文字列またはparse済み値をstrictに検証する。`events`は1〜10件、`no_change`は正常な変化なしとする。候補は既存Affect domainのlayer・target・family・value・intensity・reason・evidenceと`sourceTurnId`だけを持つ。余剰field、memoryEpisode、空文字列、不正enum／数値／組合せは拒否し、不正候補の除去やno_changeへの置換はしない。用途指示は会話を基本材料とし、必要な操作結果だけを参照してCharacterの次の感情を構成する。非公開内面の復元・診断や、作業失敗から根拠のないユーザーへの敵意を構成しない。

Main内部の`BackgroundAffectApplicationService.apply(execution, output: AffectCompositionOutput)`は、検証済み候補と同一のexecutionを受ける。registryの実背景binding、current handle／admission、affect用途とlocal-userの権限を検証する。アプリ所有の`readMainSource(historyScope)`は、実Mainのmetadata、同じstorage読取境界で観測した既存ownerIdentity、入力材料に渡した保存済みTurnのid／sessionId／phase／completedAt／assistantMessageSeqを返す。別owner・別Character・読取専用・character-authoring、許可history／processing範囲外のTurn、未対応のAuxiliaryは保存前に拒否する。targetType／targetIdは感情の対象であり保存ownerを選ばない。

final全体とsource参照を検証後、schemaVersion・Character／user／Main owner・Turnのcanonical UTC completedAt・新規保存keyをアプリが補う。occurredAtは観測上の時刻であり、非公開内面の発生時刻を認定しない。取得時点と保存時点のAffect version／projection／定義revisionは比較しない。

保存は背景の`RuntimeTurnAdmission`を適用し、`CharacterAffectService.recordAppraisal`から既存Memory Workerの`affect.recordEvent`、`CharacterAffectStorage.recordEvent`へ一件ずつ進む。expectedVersionとmemoryEpisodeは渡さず、versionの付け直しやMemory appendは行わない。通常のcorrect／resetのversion契約とlinked episodeは変更しない。実行中のadmissionだけを利用する。

用途結果は`no_change`、全件応答確認済みの`saved`、最初の失敗で終了した`stopped`を区別する。確認済みprefixにはcandidateIndex・eventId・created／replayedを残し、失敗位置と未呼出indexを別に返す。既存例外が未保存を保証する場合だけeffectをnoneとし、送信後の不明な効果はunknownとする。取消後も確定済みprefixを戻さず、後続、補償、再照合、自動再送を呼ばない。保存済みAffectは既存の通常getContext／projectionから利用する。専用checkpoint／receipt／batch／復旧待ちは持たない。

この用途moduleは単体で保持されているが、共通runOnceやMCP／CLIの登録経路からは呼ばない。用途検証のtool境界への接続、本番の用途組立ては未接続である。公開appraise／correct／reset／contextは維持し、Auxiliaryのowner／FK／context対応も含めない。
