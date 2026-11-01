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

native終了時はMCP接続だけを閉じる。saveは既存`runWithRuntimeTurnAdmission`内で実行し、保存callbackが返るまで論理実行を保持する。generation／saveがpendingでも通常turnを予約・終了せず、主会話側へ待機を追加しない。通常Window closeや主会話のCancelを背景signalへ接続しない。

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

履歴factoryとtool→operation対応を`SessionHistoryMcpRegistration`で登録する。factoryは許可operationだけを登録し、hostも直接tools/callの操作grantを検証する。履歴専用endpointは背景だけに公開し、通常turnからは利用できない。初期の背景接続は履歴endpointだけを許可し、Memory／Glossary／Session Graph endpointを拒否する。Memory読取の追加接続は別の実装単位であり、現段階で背景Memory書込を許可するものではない。

Provider builderは通常接続の既存3 endpointと背景のsession-history endpointを分ける。Mainはruntime開始時に履歴の実factoryとtool→operation対応を登録し、認可resolverの共通scope・admissionをStorage Workerの履歴readへ渡す。factory未登録なら背景接続を拒否し、空の履歴成功へ置換しない。公開操作と配布CLIの契約は[Session History](session-history.md)を参照する。

native完了時は`nativeCompleted()`から`host.closeConnection()`を呼び、HTTP token・MCP endpoint・進行中readを閉じる。論理admissionは維持し、アプリの保存結果が成功・失敗・unknownとして返った後に`finish()`する。取消・source／親削除・runtime停止はbinding／handleを失効し、未確定の保存をadmissionで拒否する。確定済み保存は巻き戻さない。provider credential変更・無効化ではその背景Providerの実行を失効させる。

この基盤は自動生成を起動せず、通常turn内の現行Memory／Affect操作は維持している。実Providerの副作用制限・実LLM呼出し、背景Memory read、用途別設定・通知・頻度、実storeへの用途保存とAuxiliary保存は共通runOnceだけでは接続されない。採用判断と適用範囲は[ADR035](../adr/035-background-execution-binding-and-history-scope.md)、通常の実行は[Provider Adapter](provider-adapter.md)に従う。
