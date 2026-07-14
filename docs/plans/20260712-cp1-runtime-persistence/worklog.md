# Worklog

## 2026-07-12: CP1 Plan作成

- parent roadmapのCP1を`進行中`へ変更した。
- CP1をS1〜S8へ分割した。
- 現在地をS1着手前とした。
- S1でstack、SQLite driver、Worker transport、test runnerを比較して確定する。
- 旧`package.json`は比較証拠に限定し、現行stackとして採用していない。
- S1開始を止めるuser回答待ちはない。

## 2026-07-12: S1 Stack / Driver / Transport Decision完了

- 旧実装のnpm、ESM、TypeScript、tsx、Node.js test runnerを基礎stackとして踏襲した。
- production runtimeをElectron 42最新patch、standalone runtimeをNode.js 24.16以上24系とした。
- SQLite driverを`node:sqlite` `DatabaseSync`とし、Persistence Workerだけがconnectionを所有する方針を確定した。
- transportを`worker_threads`とし、BLOB chunkは専有`ArrayBuffer`をtransferする方針を確定した。
- `scripts/probe-runtime-persistence.mjs`をNode.js 22.22.0で実行し、transaction rollback、backup、16 MiB transfer、Worker crash検出が成功した。
- target Electron / Node.js 24での再実行とpackaged Worker起動はS2以降のGateへ残した。
- S1の質問5件を確認済みにし、現在地をS2着手前へ更新した。

## 2026-07-12: S2 Project Scaffold完了

- rootへ`package.json`と`package-lock.json`を追加し、direct dependencyをexact versionで固定した。
- TypeScript project referenceで`src/shared`、`src/main`、`src/persistence-worker`、testを分離した。
- persistence protocol version 1の最小envelope型とschema artifact resolverを追加した。
- Main / sharedからSQLite ownershipが漏れないmodule boundary validatorを追加した。
- npm scriptsとしてbuild、typecheck、lint、format、test、runtime probeを追加した。
- `npm ci`、typecheck、test、build、format check、schema validatorが成功した。
- Node.js 24.18.0とElectron 42.5.2同梱Node.js 24.17.0でruntime persistence probeが成功した。
- docs-syncは`workspace-only`と判定した。S2は既存の責務決定をscaffoldへ反映した段階であり、新しい長期設計契約はD1-011へ記録済みのため、`docs/design/`は追加更新していない。
- 別視点reviewで、test用`.tsbuildinfo`のroot漏出、schema validatorの`npm test`未統合、MJSを検査対象に見せる無効なTypeScript includeを検出した。
- `.tsbuildinfo`を`dist/.tsbuildinfo`へ移し、Python 3 resolver経由でschema validatorを`npm test`へ統合し、MJSは`node --check`で検証するよう修正した。
- 現在地をS3 SQLite Bootstrap / Schema Verification着手前へ更新した。

## 2026-07-12: S3 SQLite Bootstrap / Schema Verification完了

- 新DB専用pathを明示的に受け取り、旧DB path、hardlink、symlink経由の別名をopen前に拒否するbootstrapを追加した。
- file不存在、空DB、中断初期化、現行、identity不一致、unknown / future DBを分類し、拒否時に元fileを変更しない検査経路を実装した。
- sidecarがない既存DBはimmutable read-only URIで検査し、WALまたはrollback journalが残るDBは一時snapshot側で検査・recoveryするようにした。
- schema DDLを純粋なtable / index / trigger artifactへ分離し、transaction、identity / version、manifest、integrity、WAL、connection PRAGMAの適用と検証をruntimeへ集約した。
- manifest不一致をcommit前に拒否し、DDL失敗後にuser objectを残さず再試行できることをcontract testで確認した。
- schema drift、non-SQLite、lock contention、pending WAL、hot journal、migration pathのfailure modeを追加した。
- 別視点reviewでlegacy path alias、commit後manifest検証、snapshot競合検出、DDL artifactによるtransaction脱出の不足を検出し、file identity照合、transaction内manifest検証、snapshot前後のfile identity / content hash比較、禁止statement検査とSQLite authorizerへ修正した。
- docs-syncは`repo-sync-required`と判定し、bootstrap責務と非破壊inspection契約を`docs/design/sqlite-schema-lifecycle.md`へ同期した。
- 現在地をS4 Persistence Worker Lifecycle着手前へ更新した。

## 2026-07-12: S4 Persistence Worker Lifecycle完了

- generation付きversioned protocol、strict runtime decoder、safe error / effect contractを追加した。
- Main側にWorker client state machine、request timeout / cancel、late response破棄、startup / crash収束、graceful / forced shutdownを実装した。
- Worker側にsingle FIFO executor、queue上限、同期write transaction wrapper、runtime operation registryを実装した。
- request sequence high-water markで世代内replayをconstant memoryで拒否するようにした。
- `payload.read_chunk`を最大256 KiBのstateless range readとし、専有`ArrayBuffer`のtransfer経路を追加した。
- shutdownをadmission停止、queued failure、running完了、primary close、maintenance checkpoint、closed通知の順に固定した。
- 高リスクreviewでrequest replay、同期例外cleanup、shutdown race / 相関、chunk上限、message flush、async transaction misuse、replay Setのmemory growth、maintenance PRAGMA不足を検出し、回帰testとともに修正した。
- docs-syncは`repo-sync-required`と判定し、長期contractを`docs/design/persistence-worker-lifecycle.md`へ同期した。
- Node.js 24.18.0で全32 test、開発shellのNode.js 22.22.0ではtarget Worker test 6件を明示skipした残り26件とschema validatorが成功した。
- Electron 42.5.2同梱Node.jsでWorker lifecycle test 8件が成功した。
- 現在地をS5 Repository Read Model着手前へ更新した。

## 2026-07-12: S4 follow-up review対応

- async transaction callbackを型とtransaction開始前のruntime検査で拒否し、`await`後のwriteがtransaction外へ逃げない回帰testを追加した。
- Main clientでoperationを送信前decodeし、不正operationをpendingへ登録せず`protocol_invalid`へ収束させた。
- shutdown deadlineを`closed`受信後のWorker exitまで適用した。
- maintenance timeout / crash / forced shutdownを保守的に`effect=unknown`へ分類した。
- response上限をtransfer bufferとJSON metadataの合計256 KiBとして検証した。

## 2026-07-12: S5 Repository Read Model完了

- typed `RepositoryReadClient`とoperation別strict decoder、version付きopaque cursorを追加した。
- Session pageでactive / latest Runとexecution stateをbounded queryから導出した。
- Message、RunEvent、RunOutput、child resultをscope付きordinal pageとして実装した。
- RunOutput countと内部recovery projectionを追加し、scope不一致を`not_found`へ収束させた。
- timelineでは64 KiBを超えるMessage本文をinlineせず、本文とstored payloadをscope付きchunk readへ分離した。
- representative query planでMessage / Event / Output ordinal indexを確認し、large output fixtureでpage上限とpayload非hydrateを検証した。
- docs-syncは`repo-sync-required`と判定し、長期contractを`docs/design/persistence-worker-repository.md`へ同期した。
- 現在地をS6 Repository Write Transactions着手前へ更新した。

## 2026-07-12: S5 follow-up review対応

- RunEventとRunOutputの公開SELECT列を明示し、内部dedupe key、workspace照合列、Provider内部IDを除外した。
- cursor scopeを構造化scopeのSHA-256 digestへ変更し、長いscopeと区切り文字衝突を解消した。
- Session pageにも192 KiB byte budgetを適用し、単一oversize ordinal rowを明示omissionとして進行可能にした。
- Session IDをschemaで最大1024文字に制限し、Session cursorのsort keyがresponse / decode上限を超えないようにした。
- category付きRunOutput queryを専用SQLへ分離し、category ordinal indexの利用をquery plan testへ追加した。

## 2026-07-12: S6-A typed command / Session操作完了

- typed `RepositoryWriteClient`、command result / domain error、operation別strict decoderを追加した。
- fingerprintをWorker側で生成するidempotency coreを実装し、exact replay、conflict、expiry tombstone、response reference再検証を追加した。
- active Session作成とself-scope completed IdempotencyRecordを同じtransactionで確定するcommandを追加した。
- expected lifecycleを必須にしたarchive / unarchive / closeを実装し、active Run中のarchive / closeを全rollbackで拒否した。
- idempotency completed responseの保持期間をWorker所有の30日へ固定した。
- docs-syncは`repo-sync-required`と判定し、write責務を`docs/design/persistence-worker-repository-write.md`へ同期した。

## 2026-07-12: S6-A follow-up review対応

- unarchiveの再開可能Bindingを同じProviderの`active && persistent`に限定し、ephemeral Bindingを拒否した。
- 追加許可directoryのsparse配列と相対pathを拒否し、絶対pathの重複・包含関係をWorker境界で字句正規化した。
- 期限切れIdempotencyRecordをfingerprint conflict判定より先にscrubし、応答codeを変えずにenvelopeを消去した。
- docs-syncは`repo-sync-required`と判定し、境界条件を`docs/design/persistence-worker-repository-write.md`へ同期した。

## 2026-07-12: S6-B1 通常Run admission完了

- typed `repository.run.admit` commandとMain process client methodを追加した。
- 新規user Message、queued Run、preparing Attempt、pending Dispatch、必要なcreating Binding intent、Run参照のcompleted IdempotencyRecordを1 transactionで確定した。
- Provider request本文を保存せず、canonical JSONからWorkerがDispatch fingerprintを生成する境界を追加した。
- active Session、non-terminal Run不在、Binding intent、ID衝突、response referenceをtransaction内で再検証した。
- execution snapshotの必須構造とSession Provider一致、persistent Bindingだけの再利用、app全体 / Provider別capacityをadmission境界へ追加した。
- exact replay、Binding作成 / 再利用、inactive / busy時の部分row不在をcontract testで固定した。
- S6-Bの残りはBinding確定、Dispatch gate / resolution、retry admission、supplemental inputとする。

## 2026-07-12: S6-B1 contract test follow-up

- Run参照のidempotency replayについて、fingerprint conflict、expiry scrub、Run参照欠落を直接検証した。
- Dispatch insert直前のfault injectionでtransactionを中断し、Message / Run / Attempt / Binding / Dispatchがすべてrollbackされることを固定した。
- 同じDBを所有する2 Workerからcapacity上限1のRun admissionを同時実行し、`BEGIN IMMEDIATE`により成功1件と`capacity_exceeded` 1件へ直列化されることを確認した。

## 2026-07-12: S6-B2a Provider Binding resolution完了

- `repository.binding.resolve`とtyped Main process client methodを追加した。
- 外部会話ID確定時にcreating Bindingのactive化と作成元AttemptへのBinding参照設定を同じtransactionで確定した。
- 会話作成結果がambiguousな場合にBinding / Attempt / Run / Dispatchを`invalidated / interrupted / interrupted / aborted`へ一括収束させた。
- exact replayと異なる確定値のconflictを自然キーとstateで判定し、IdempotencyRecordを重複追加しない境界を固定した。
- ephemeral Bindingのlive ownership tokenをcommit後のWorker memoryだけへ登録し、再起動後にDB状態だけからresumeしない土台を追加した。

## 2026-07-12: S6-B2b Run Dispatch transition完了

- `repository.dispatch.begin` / `repository.dispatch.resolve`とtyped Main process client methodを追加した。
- Run / Attempt / Binding / Dispatchの共通GateとProvider request fingerprintをtransaction内で再検証した。
- `pending -> dispatching`の初回commitだけ`sendAllowed=true`とし、response loss後のexact replayでは再送を許可しない契約を固定した。
- accepted時にAttempt / Dispatch / Runを同時にactive化し、rejected / ambiguousではDispatchだけをterminal化して後続policyへ委譲した。
- ephemeral live ownershipを初回sendと未確定resolutionへ要求し、Worker再起動後にtokenを再登録しないことをcontract test化した。
- accepted resolution終盤のfault injectionでAttempt / Dispatch / Runが一括rollbackされることを確認した。

## 2026-07-13: S6-B2 follow-up review対応

- `canceling` Runをpending Dispatchの初回送信Gateから除外し、dispatching済みのreplay / resolutionだけを許可した。
- Provider照会が外部実行IDを一意に証明した場合に限り、`ambiguous -> accepted`へ再送なしで相関補正する経路を追加した。
- Binding作成とDispatch結果からRunの`external_side_effect_state`を`none -> unknown -> present`の方向へ更新し、確定済み`present`を後退させない契約を固定した。
- Binding作成ambiguousによるRun terminal確定時にSessionの`last_activity_at`を同じtransactionで進めた。
- active Bindingのexact replayを後続Run / Attempt / Dispatch stateから独立させ、resultをBindingの確定値へ限定した。

## 2026-07-13: S6-B3 retry / supplemental input完了

- terminal Runから元user Messageを再利用する`repository.run.retry`を追加し、直接retry chain、capacity、Binding、idempotencyの共通Gateを固定した。
- `repository.run.input.admit`でactive Run / Attempt / Bindingとaccepted Dispatchを再検証し、supplemental user Message、pending Delivery、Delivery参照のIdempotencyRecordを1 transactionで確定した。
- `repository.run.input.begin`の初回commitだけProvider送信を許可し、dispatching後のreplayでは再送を禁止した。
- `repository.run.input.resolve`でaccepted / rejected / ambiguousをterminal化し、Run終了後も送信済み入力のProvider結果を記録できるようにした。
- ephemeral Bindingのlive ownershipを初回sendと未確定resolutionへ要求し、Worker再起動後の自動送信を拒否した。
- atomic rollback、Gate違反、idempotency conflict / expiry / 参照欠落、3種のresolutionとexact replayをcontract testで固定した。
- Provider capabilityはApplication Service、durable state GateはPersistence Workerの責務とし、CP2ではcapability確認後だけtyped commandを構築する統合を追加する。

## 2026-07-13: S6-C RunOutput / terminal / child result collect完了

- `repository.run.output.append`とpending payload resolutionを追加し、item / Run / Session / app quota、DB volume reserve、自然replay、payloadとのatomicityを固定した。
- `repository.run.terminal`でAttempt、Run、final Message、terminal Event、軽量output、Session activityを一括確定し、child RunではDelivery availabilityとDelegation workflowも同じtransactionへ含めた。
- terminal commandの非公開dedupe fingerprintを`RunEvent.dedupe_key`へ保存し、pending payload解決後もexact replayを判定しつつ、公開Eventは専用recordへの参照だけを保持する。
- `repository.child-result.collect`で初回collection、parent RunEvent、child Session scoped IdempotencyRecordを一括確定し、replay envelopeをDeliveryの確定値と照合した。
- SQL例外だけでなく`RAISE(IGNORE)`によるsemantic conflictでも部分commitしないrollback経路を追加した。
- 次はS6-B4のchild / Auxiliary admission入口を実装し、fixture依存だったchild terminal / collectをproduction command経由で到達可能にする。

## 2026-07-13: S6-C follow-up review対応

- Provider Attemptのterminal failure originからschema非対応の`persistence`を除外し、decoder境界とrollback回帰を固定した。
- terminal / child collectionのRunEventから専用recordにある状態・summaryの複製を除き、参照専用契約へ揃えた。
- Run、Session、appの累積payload quotaを、それぞれの集計分岐へ到達する独立fixtureで検証した。
- output append、terminal、pending resolution、child collectionをproduction Workerとtyped client経由で統合検証した。
- 恒久設計文書の局所的な型・処理仕様を削り、terminal優先、child transaction所有、正本へのpointerへ縮めた。

## 2026-07-13: S6-B4 initial child admission完了

- `repository.child.start`を追加し、初回child Session、relation、instruction Message、Delegation、Run / Attempt / Binding intent / Dispatch、pending Delivery、parent scopeのIdempotencyRecordを一括commitする入口を実装した。
- 入れ子のchild admissionでもorchestration rootのnon-terminal child Run数を集計し、app全体 / Provider別capacityと同じtransactionで拒否する契約を固定した。
- exact replayは後続のBinding / Dispatch状態に依存せず、fault injection時はchild treeとidempotency recordを全rollbackする回帰を追加した。
- production Workerとtyped client経由でchildを開始・dispatchし、再起動後のterminal / collectまで到達する統合fixtureへ置き換えた。
- child startのsemantic fingerprintをcommand全体のcanonical JSONから生成し、object key順が異なるexact replayを同一視する契約を追加した。
- root / application / Provider capacity超過を、scope、現在値、上限、必要なscope IDを持つ型付きdetailsとして返すようにした。
- Auxiliary固有の親Session排他とcontext引継ぎは永続化commandへ推測実装せず、既存計画どおりCP5のApplication Service policyに残した。
- 次はS6-DのSession subtree deleteとstartup repairへ進む。

## 2026-07-13: S6-D Session subtree delete実装

- `repository.session.delete-subtree`を追加し、transaction内で再帰的にtreeを確定してnon-terminal Runがあれば`session_busy`で無変更にした。
- subtree内のdomain rowとscope内IdempotencyRecordを物理削除し、subtree外parentのEvent参照を除去、削除対象を参照するparent scopeのcompleted idempotencyをexpired tombstoneへ進めた。
- Binding / Attemptとoutput item / payloadの循環参照はdelete transaction中だけdeferし、commit時のforeign key検証を維持した。
- 単一child、3階層の中間branch、無関係Session保持、late fault rollback、production Worker / typed client経路をcontract testで固定した。
- resultのSession ID群はDB commit後のSession Files冪等削除へ渡し、`localOnly=true`でProvider側削除を保証しない。
- S6-Dの残りはstartup repair commandとmaintenance境界の統合検証。

## 2026-07-14: S6-D Session subtree delete review対応

- 再帰treeに別workspaceのSessionが混入した場合、manifest作成と削除前に`reference_invalid`で拒否する回帰を追加した。
- subtree外へcleanup manifestを原子的に作成し、deletion IDによるexact replayとSession IDのbounded page取得を追加した。
- delete responseをcleanup token、削除件数、local-only表示へ縮め、最大長ID 256件を含むtreeでもresponse sizeがtreeに依存しない契約を固定した。
- Application ServiceがSession Filesを冪等削除した後にmanifestを完了できるtyped commandを追加した。
- 物理削除、unknown effect recovery、filesystem cleanup、local-only境界の選択を`docs/adr/001-session-subtree-delete-cleanup-manifest.md`へ記録した。
- S6-Dの残りはstartup repair commandとmaintenance境界の統合検証。

## 2026-07-14: S6-D startup repair実装

- `repository.startup.repair`を追加し、期限切れidempotency response、未送信Dispatch、terminal child Delivery、pending output payload、Delegation latest参照を一つのtransactionで単調収束させた。
- Provider照合が必要なcreating Bindingとdispatching / ambiguous Dispatch、自動送信候補、ephemeral resume不可、Run / idempotency / Delivery診断をboundedな件数で返すようにした。
- Application Serviceが対象Runを再取得できるよう、既存`repository.recovery.get`をtyped read clientへ公開した。
- Provider I/Oや外部ID推測はWorkerへ持ち込まず、既存Binding / Dispatch resolutionとの境界を維持した。
- local convergence、再実行時の無変更、late fault全rollback、production Worker / typed client経路をcontract testで固定した。
- lint、typecheck、build、format、schema validator、Node 24全112 testを通し、S6を完了した。次はS7のcontract / concurrency / fault testを進める。

## 2026-07-14: S7 Contract / Concurrency / Fault Tests完了

- schema / PRAGMA / drift、cross-row制約、各write transactionのfault rollback、idempotency、capacity競合、payload制限、Worker lifecycle、startup repairの既存contract coverageをGateへ対応づけた。
- 実DBの`BEGIN IMMEDIATE`競合でDispatch beginをtimeoutさせ、unknown effect後の再実行が`sendAllowed=false`となりProvider二重送信を許可しないproduction Worker回帰を追加した。
- lint、typecheck、format、schema validatorとNode 24全113 testを通し、S7を完了した。次はS8のpublic API / integration reviewを進める。

## 2026-07-14: S6-D startup repair review対応

- terminal / canceling Runが所有するcreating Bindingをstartup repairでinvalidatedへ進め、外部会話作成の未送信を証明できないRunはexternal side effectを`unknown`へ単調更新した。
- `repository.recovery.get`がAttempt側の確定Bindingだけでなく、create intent中のBindingを作成元Attemptから決定的に取得できるようにした。
- recovery projectionのnullable必須fieldをnullのown propertyとして返す専用mappingを追加した。
- delivery参照のidempotency診断をoperationごとのtableとscopeへ分離し、Child DeliveryとRun Input DeliveryのID衝突で欠落を隠さないようにした。
- Child Result診断へRun terminal phaseとsnapshotの一致、relation child Sessionのownershipを追加した。
- Main / Worker / Provider間のstartup recovery責務と二重送信防止の選択を`docs/adr/002-startup-repair-reconciliation-boundary.md`へ記録した。
- lint、typecheck、build、format、schema validator、Node 24全115 testを通し、review後のS6-D / S7 contractを再固定した。

## 2026-07-14: S8 CP1 Integration Gate完了

- Mainのpublic barrelからraw write operation catalogを外し、CP2が利用するtyped read / write client、domain error、transport error、recovery / startup repair型を公開contract testで固定した。
- read operation名をshared定数へ集約し、typed clientとWorker registryのmapping driftを防止した。read filterとexecution stateも既存union型へ狭めた。
- MainからSQLite / Worker実装への直接依存、sharedからruntime依存、Persistence WorkerからMainへの逆依存をstatic checkで拒否した。
- Node.js 24.16.0でclean `npm ci`を実行し、Node.js 22の既定shellではtestをfail-fastするruntime guardを追加した。
- production Workerのstructured clone / transferable readをtyped client経路で検証した。compiled `dist` Workerのstart、ping、checkpoint、shutdownと終了後のWAL / SHM / journal不在をWindows smokeへ固定した。
- compiled smoke 7回の観測値はstartup中央値49.12 ms、p95相当54.76 ms、全体中央値56.29 ms、p95相当63.77 msだった。性能budgetは設けず、CP8で比較するbaselineとする。
- Node.js 24でlint、typecheck、build、format、schema validator、runtime probe、全116 testを通した。test runner本体は1.60〜1.82秒、外部runnerを含む観測wall timeは2.86秒だった。
- repository内と今回生成したprobe / smoke一時directoryにDB / WAL / SHM / journal / backup artifactが残らないことを確認した。既存OS tempに過去実行由来の残留があるが、今回のrunで増加はなくCP2の責務は変えない。
- ADR gateは既存責務の検証強化で新規判断がないため非該当、architecture document gateは既存のRepository read / write文書がsourceとexecutable contractを指しており追加同期不要と判定した。
