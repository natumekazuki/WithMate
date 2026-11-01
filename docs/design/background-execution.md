# Background Execution

## 共通基盤の責務

`BackgroundExecutionService`はアプリ管理の一回の実行寿命と同時上限を所有する。Provider推論、生成内容の判断、処理位置の永続化や自動retryは行わない。三用途は`character-memory`、`target-memory`、`affect`であり、通常Session・Auxiliaryの実行状態・threadを背景用に書き換えない。

`AgentRuntimeBindingRegistry.issueBackground()`は新規bindingを発行する。actorSessionIdは元の実Session IDで、背景Providerは元SessionのProviderと独立する。通常bindingの再利用・generation取得・変更通知と背景を分離する。背景の発行・取消や通常turnの次回開始は互いのbindingを置換しない。

自動生成のsourceは既存`isReadOnlySession`の対象とcharacter-authoringを除外する。背景開始は実SessionとscopeのSession／incarnation／Characterを照合する。主会話のCancel、Window closeを背景取消へ接続しない。

全体3件、用途×conversation ownerIdentityごと1件までを同時に保持する。満杯・同じ用途の実行中は明示的な起動見送りを返し、bindingを発行しない。待機queueやtimerを持たず、呼出元が未処理を保持して枠解放時に再評価する。finishは保存結果の確定／失敗と所有処理の終了後に呼ぶ。

Mainはruntime開始成功で`start()`し、停止開始で`stop()`する。停止はnative接続閉鎖済みの実行も失効し、新しい背景開始を再起動まで拒否する。

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

履歴factoryとtool→operation対応を`SessionHistoryMcpRegistration`で登録する。factoryは許可operationだけを登録し、hostも直接tools/callの操作grantを検証する。履歴専用endpointは背景だけに公開し、通常turnからは利用できない。初期の背景接続は履歴endpointだけを許可し、Memory／Glossary／Session Graph endpointを拒否する。Memory読取の追加接続は別の実装単位であり、現段階で背景Memory書込を許可するものではない。

Provider builderは通常接続の既存3 endpointと背景のsession-history endpointを分ける。Mainはruntime開始時に履歴の実factoryとtool→operation対応を登録し、認可resolverの共通scope・admissionをStorage Workerの履歴readへ渡す。factory未登録なら背景接続を拒否し、空の履歴成功へ置換しない。公開操作と配布CLIの契約は[Session History](session-history.md)を参照する。

native完了時は`nativeCompleted()`から`host.closeConnection()`を呼び、HTTP token・MCP endpoint・進行中readを閉じる。論理admissionは維持し、アプリの保存結果確定後に`finish()`する。取消・source／親削除・runtime停止はbinding／handleを失効し、未確定の保存をadmissionで拒否する。確定済み保存は巻き戻さない。provider credential変更・無効化ではその背景Providerの実行を失効させる。

この基盤は自動生成を起動せず、通常turn内の現行Memory／Affect操作は維持している。Providerの副作用制限・実LLM呼出し、用途別設定、背景Memory read・用途保存への接続は実装済みとして扱わない。採用判断は[ADR035](../adr/035-background-execution-binding-and-history-scope.md)、通常の実行は[Provider Adapter](provider-adapter.md)に従う。

## Memory生成の純粋な用途契約

`src-shared/memory-recording/`は二用途の頻度と構造化候補を扱う。Provider、DB、timer、admission取得、保存処理は持たない。

`memory-recording-frequency.ts`は`character-memory`と`target-memory`に独立した既定5 Turn／idle 5分を提供する。設定validatorはTurn数を1以上の安全な整数、idle分数を正の有限値として検証し、不正値を既定値へ置換しない。`getMemoryRecordingTrigger`は呼出側がowner×用途ごとに渡す未開始の終端Turn件数・頻度・実行中状態・連続idle分数から、`none`／`turn_count`／`idle`だけを返す。0件は起動せず、N件以上は実行中でも件数条件を満たし、端数は実行中でなくT分idleのときだけ条件を満たす。全体上限や実開始は既存admissionの責務である。

`memory-recording-candidates.ts`は用途別schemaとvalidatorを提供する。候補ありは非空配列、候補なしは明示的な`no_candidates`だけを受け入れ、未知fieldや不正値を拒否する。Characterは既存episode型と事実／受け取りの区別、対象Memoryは既存kind・本文・tagと許可slotを使う。本文の制限・trim・tag正規化は通常Memory appendと同じ純粋validatorを共用する。

アプリは固定history範囲、参照可能な保存messageとそのprocessing所属、操作／checkのindexと確認済み成否をcontextへ渡す。validatorは根拠の実在・範囲と候補ごとにprocessing根拠があることを確認する。`execution_result`には成功確認済みの操作またはcheckを必要とし、failed／unknownを成功へ補完しない。対象Memoryへ`character_interpretation`は保存候補として返さない。これは参照・値の検証であり、自然言語の真偽や同一性を証明するものではない。

Characterの保存先はcontextの当該Character targetで固定し、対象Memoryはcontextのslot→targetだけを返す。モデル出力にowner、target tuple、権限、保存key等を受け付けない。contextはアプリが認可済みの実sourceから構成する内部入力であり、生成出力の自己申告から作らない。実owner／admissionの認可は接続側が担う。schemaは`z.toJSONSchema(schema, { io: "input" })`で生成用の構造schemaにでき、実在確認・正規化はvalidatorを通す。現時点では通常turnのMemory操作・生成経路にこのmoduleを配線していない。
