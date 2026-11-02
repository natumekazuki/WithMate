# Background Execution

## 共通基盤の責務

`BackgroundExecutionService`はアプリ管理の一回の実行寿命と同時上限を所有する。`BackgroundCallService.runOnce()`はこのserviceに実行を委譲し、注入されたgeneration portと用途側save callbackを一度だけ呼ぶ。三用途は`character-memory`、`target-memory`、`affect`であり、通常Session・Auxiliaryの実行状態・threadを背景用に書き換えない。

`AgentRuntimeBindingRegistry.issueBackground()`は新規bindingを発行する。actorSessionIdは元の実Session IDで、背景Providerは元SessionのProviderと独立する。通常bindingの再利用・generation取得・変更通知と背景を分離する。背景の発行・取消や通常turnの次回開始は互いのbindingを置換しない。

自動生成のsourceは既存`isReadOnlySession`の対象とcharacter-authoringを除外する。背景開始は実SessionとscopeのSession／incarnation／Characterを照合する。主会話のCancel、Window closeを背景取消へ接続しない。

全体3件、用途×conversation ownerIdentityごと1件までを同時に保持する。満杯・同じ用途の実行中は明示的な起動見送りを返し、bindingを発行しない。待機queueやtimer、第二の実行管理表は持たない。finishは保存結果の確定／失敗／unknownと所有処理の終了後に呼ぶ。

Mainはruntime開始成功で`start()`し、停止開始で`stop()`する。停止はnative接続閉鎖済みの実行も失効し、新しい背景開始を再起動まで拒否する。

## 共通の単発呼出

正本は`src-electron/providers/background-call-service.ts`。`BackgroundCallInput<Output>`は次を受け取る。

- `context`: 実Session、actorSessionId、既存authority snapshot・operation grants・scopeと任意の背景用signal。scopeだけでbeginの認可contextを代用しない。
- `selection`と`userInput`: 背景Provider／Modelと用途入力。generation portへ実source Sessionも渡し、通常promptの組立てへ接続できる。source SessionのProvider／threadは背景選択で書き換えない。
- `final.schema`と`final.parse`: generation portへ渡すschemaと、返されたunknown値を検証する同期parser。
- `onAdmitted`: 枠取得後に呼ぶ同期callback。起動側の開始対象位置更新用であり、保存成功通知ではない。
- `save`: 検証済み出力と、同じ実行のscope・RuntimeTurnAdmission・AbortSignalを受けるtrusted appのcallback。

順序は`begin → onAdmitted → 一度生成 → nativeCompleted → final検証 → save → finish`。generation portはfinal値だけを返し、途中応答・前置き・transcriptをfinalへ混ぜない。通常threadや暗黙のProvider継続履歴を材料の代わりに使わない。portの実Provider adapterは現在接続していない。

capacity／already_activeでは`skipped`を返し、callbackを呼ばない。beginのsource／authority不備と停止runtimeの例外はrejectとして保持し、unavailableへ一括変換しない。事前取消は`canceled`。開始後の生成失敗は`failed`、不正finalは`invalid_output`、保存開始前の取消・失効は`canceled`を返す。callbackやparseが失敗してもfinishへ到達する。

native終了時はMCP接続と背景bindingの操作grantを閉じる。saveは既存`runWithRuntimeTurnAdmission`内で実行し、保存callbackが返るまでidentityと論理実行を保持する。generation／saveがpendingでも通常turnを予約・終了せず、主会話側へ待機を追加しない。通常Window closeや主会話のCancelを背景signalへ接続しない。

## 保存結果と例外

生成後の結果は`{ kind: "generated", save }`で返し、生成成功を保存成功と同一視しない。`BackgroundSaveResult`の意味は次のとおり。

| kind | 意味 |
| --- | --- |
| `saved` | 候補ありで全候補の成功応答を確認。`confirmedSavedCount`は確認済み件数。 |
| `none` | 用途parserが確認した正常な候補なし／変化なし。用途callbackはwriteしない。 |
| `stopped` | 拒否・失敗・unknown・取消・失効で停止。用途callbackが確認した件数とcause／codeを保持する。 |

用途callbackは既存service／storeの必要なtransactionを利用し、部分保存を把握して返す。共通部は保存本体、全件atomic保存、補償、読取再照合、retryを持たない。保存開始後の例外では共通部がprefix件数を知らないため、`stopped.confirmedSavedCount = null`とする。nullは0件や全件未保存の意味ではない。

例外の効果が不明ならcauseは`unknown`、codeがなければ`BACKGROUND_SAVE_UNKNOWN`を返す。既存`RuntimeTurnInactiveError`ではcauseを`revoked`、codeを`RUNTIME_TURN_INACTIVE`にするが、先行保存件数は依然nullである。callbackが報告した部分保存やunknown、確定済みの成功は、その後のCancelやstopで上書きしない。finish後のadmissionは失効し、保存callbackから返った権限を再利用できない。

順序・鮮度・重複・取りこぼしの完全保証は行わない。失敗・unknownはその実行を終了し、次の通常契機を過去結果の解消待ちにしない。永続checkpoint・receipt・候補queue、内容変更追跡、専用復旧の状態やAPIは設けない。認可・許可read scope・正しいowner／target・失効権限の拒否と、既存データ保護は維持する。

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

履歴factoryとtool→operation対応を`SessionHistoryMcpRegistration`で登録する。factoryは許可operationだけを登録し、hostも直接tools/callの操作grantを検証する。履歴専用endpointは背景だけに公開し、通常turnからは利用できない。背景接続には履歴とMemoryのendpointだけを許可し、Glossary／Session Graphを拒否する。Memory factoryは背景readの具体的grantに一致するtoolだけを登録する。

Provider builderは通常接続の既存3 endpointと、背景のsession-history／Memory endpointを分ける。Mainはruntime開始時に履歴の実factoryとtool→operation対応を登録し、認可resolverの共通scope・admissionをStorage Workerの履歴readへ渡す。factory未登録なら背景接続を拒否し、空の履歴成功へ置換しない。公開操作と配布CLIの契約は[Session History](session-history.md)を参照する。

native完了時は`nativeCompleted()`から`closeBackgroundOperations()`で操作grantを取り除き、`host.closeConnection()`でHTTP token・MCP endpointを閉じる。旧bound CLIと遅延したread結果も操作認可で拒否する。identity・generation・論理admissionは維持し、アプリの保存結果が成功・失敗・unknownとして返った後に`finish()`する。取消・source／親削除・runtime停止はbinding／handleを失効し、未確定の保存をadmissionで拒否する。確定済み保存は巻き戻さない。provider credential変更・無効化ではその背景Providerの実行を失効させる。

この基盤は自動生成を起動せず、通常turn内の現行Memory／Affect操作は維持している。実Providerの副作用制限・実LLM呼出し、用途別設定・通知、実storeへの用途保存とAuxiliary保存は共通runOnceだけでは接続されない。採用判断と適用範囲は[ADR035](../adr/035-background-execution-binding-and-history-scope.md)、二用途のMemory記録方針は同ADRの[#909後継判断](../adr/035-background-execution-binding-and-history-scope.md#909-memory記録の後継判断)、通常の実行は[Provider Adapter](provider-adapter.md)に従う。

## 背景Memory read

公開toolと操作grantの対応は`src-shared/agent-runtime/background-memory-read.ts`を正本とする。`memory.search`、`memory.list_entries`、`memory.get_entry`、`memory.list_tags`、`character_memory.search`だけを許可候補とし、MCPの直接tools/callと配布bound CLIも同じMemory application認可へ通す。registryは背景bindingの操作上限を履歴4操作とこのMemory readへ限定し、指定grantが広くても書込・移動・忘却・file取得／export・横断一覧・fallback・Graph／Glossaryを認可しない。

背景では実binding IDに結び付いたcurrent handle／capabilityを必須とし、元会話の実Characterとauthority snapshotを照合する。背景Providerは元会話と異なってよい。通常bindingのProvider一致条件は維持する。scopeの`memoryTargets`は実Characterと許可Projectからcanonical targetへ解決し、principalの`readTargets`で要求targetと照合する。空集合を全targetへ拡大せず、user-globalも明示captureされた場合だけ許可する。

一般MemoryとCharacter Memoryの検索は、このprincipalを既存Memory serviceからMemory Worker／storeへ渡す。`get_entry`は要求targetに加え実entryの保存targetも確認し、範囲外entryを空の成功へ変換しない。forgotten本文の通常read除外は維持する。遅延readは返却前にもadmissionを検証し、native完了・取消・失効後の本文を返さない。通常turnの確定済みwrite結果の扱いは変更しない。

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

`BackgroundMemoryContext`は許可read時にアプリが構成したfull `SessionHistoryReadScope`、processing Turn範囲、保存messageのseq・processing所属・操作/check index、slot→targetを持つ。historyとprocessingはregistryの実bindingのscopeと一致し、slotの全targetはその`memoryTargets`内でなければならない。モデルからcontextを構成しない。実行結果の成否や意味を判定する入力は不要である。

保存入口はregistryの実背景binding、current handle／capabilityと共有admission state、Memory用途、local-userとCharacterを確認する。注入される`readMainSource(history)`は実Main metadataと同じ保存読取境界で観測した既存ownerIdentityを返す。Main ID・incarnation・ownerIdentity・Characterを照合し、source不存在、read-only、character-authoring、Auxiliary、別executionや許可範囲を広げるcontextは保存前に拒否する。source readはアプリ所有portであり、モデル値や親Mainへの付け替えで代用しない。

final全体を既存二用途validatorで検証してから最初のwriteへ進む。CharacterはbindingのCharacter owner＋character scopeに固定し、既存`CharacterContextApplicationService.appendEpisode`のCharacter／Main scope検証からMemory appendへ進む。対象Memoryは許可slotを解決して既存`MemoryV6Service.append`へ進む。アプリが実binding由来の`session_binding` principal（memory.appendのみ）、schemaVersion、新規保存keyを補い、正規化済みtagを公開入力のtype/valueへ写像する。無条件のlocal-user principal、通常会話のwrite credential、新batch／別storeは使わない。Affect eventやlinked episodeは生成しない。

一候補ずつ`runWithRuntimeTurnAdmission(execution.admission)`で保存し、既存Memory Workerのmutationへ同じ共有失効stateを伝播する。native完了後も既存admissionで保存でき、実行失効後の未確定writeはWorkerでも拒否される。失効を実装するためのrevision/hash再照合や、本文の鮮度比較は行わない。

`BackgroundMemoryResult`は`no_candidates`、全件成功応答確認済みの`saved`、最初の拒否／失敗／取消／unknownで終了する`stopped`を区別する。確認済みprefixにはcandidateIndex・entryId・応答のcreated/replayedを残す。stoppedは停止候補index、error code・cause、当該保存のeffect（none／unknown）、未呼出indexを返す。候補配列を確定できない入力／権限拒否では停止indexと未呼出indexがnullになり得る。未呼出分は停止候補自体とは分ける。

serviceのErrorResponseとthrowを扱い、保存前拒否・未送信の`StorageWorkerGenerationError`・効果なしが確定したWorker拒否はnoneとする。送信後の効果が分からない場合はunknownとし、成功や全件未保存に置換しない。Character appendもMemory部分で既知の未送信／拒否をnoneとして保持する。最初の非成功後は後続保存・補償・read-reconcile・自動再送を行わない。取消後も確認済みprefixを巻き戻さない。

`toBackgroundMemorySaveResult`は共通の`BackgroundSaveResult`をimportして返す。no_candidatesはnone、savedは確認済みprefixの件数、stoppedは同じ確認済み件数とcause/codeに対応し、unknown候補を件数に含めない。この内部入口と本番source resolver・背景Memory read・共通runOnceのcallbackはまだ配線していない。実Mainの既存保存契約だけを利用し、Auxiliaryの保存owner/FK対応は含まない。

## Affect候補とMain内部保存

`affect-composition.ts`の`validateAffectCompositionOutput(unknown)`は、外部finalのJSON文字列またはparse済み値をstrictに検証する。`events`は1〜10件、`no_change`は正常な変化なしとする。候補は既存Affect domainのlayer・target・family・value・intensity・reason・evidenceと`sourceTurnId`だけを持つ。余剰field、memoryEpisode、空文字列、不正enum／数値／組合せは拒否し、不正候補の除去やno_changeへの置換はしない。用途指示は会話を基本材料とし、必要な操作結果だけを参照してCharacterの次の感情を構成する。非公開内面の復元・診断や、作業失敗から根拠のないユーザーへの敵意を構成しない。

Main内部の`BackgroundAffectApplicationService.apply(execution, final)`は、registryの実背景binding、current handle／admission、affect用途とlocal-userの権限を検証する。アプリ所有の`readMainSource(historyScope)`は、実Mainのmetadata、同じstorage読取境界で観測した既存ownerIdentity、入力材料に渡した保存済みTurnのid／sessionId／phase／completedAt／assistantMessageSeqを返す。別owner・別Character・読取専用・character-authoring、許可history／processing範囲外のTurn、未対応のAuxiliaryは保存前に拒否する。targetType／targetIdは感情の対象であり保存ownerを選ばない。

final全体とsource参照を検証後、schemaVersion・Character／user／Main owner・Turnのcanonical UTC completedAt・新規保存keyをアプリが補う。occurredAtは観測上の時刻であり、非公開内面の発生時刻を認定しない。取得時点と保存時点のAffect version／projection／定義revisionは比較しない。

保存は背景の`RuntimeTurnAdmission`を適用し、`CharacterAffectService.recordAppraisal`から既存Memory Workerの`affect.recordEvent`、`CharacterAffectStorage.recordEvent`へ一件ずつ進む。expectedVersionとmemoryEpisodeは渡さず、versionの付け直しやMemory appendは行わない。通常のcorrect／resetのversion契約とlinked episodeは変更しない。native完了後もadmissionを維持し、用途保存の成功・失敗・結果不明を受けて呼出元が`finish()`する。

用途結果は`no_change`、全件応答確認済みの`saved`、最初の失敗で終了した`stopped`を区別する。確認済みprefixにはcandidateIndex・eventId・created／replayedを残し、失敗位置と未呼出indexを別に返す。構造不正で候補配列が確定しない場合の未呼出indexはnullとする。既存例外が未保存を保証する場合だけeffectをnoneとし、送信後の不明な効果はunknownとする。取消後も確定済みprefixを戻さず、後続、補償、再照合、自動再送を呼ばない。保存済みAffectは既存の通常getContext／projectionから利用する。専用checkpoint／receipt／batch／復旧待ちは持たない。

この内部入口は共通runOnce・実Provider・終端通知・本番自動更新へ配線していない。readMainSourceの注入先には上記の内部Worker読取を使えるが、用途保存の本番組立ては未接続である。公開appraise／correct／reset／contextは維持し、Auxiliaryのowner／FK／context対応も含めない。
