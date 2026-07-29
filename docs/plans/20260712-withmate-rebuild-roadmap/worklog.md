# Worklog

## 2026-07-12: Roadmap作成

- repo planを作成した。
- `docs/index.md`、`docs/feature-inventory.md`、`docs/issue-triage.md`、最新handoff、現行design docsの後続scopeを参照した。
- checkpointをCP0からCP8の9段階に分割した。
- CP0を完了、CP1を次に着手とした。
- CP1を止める質問はない。stack / SQLite driver / Worker transportはCP1開始時に調査して確定する。
- 旧roadmapは`old/`の参考資料に限定した。

## 2026-07-12: CP1開始

- `docs/plans/20260712-cp1-runtime-persistence/plan.md`を作成した。
- CP1を`進行中`へ更新した。
- 現在地はS1 Stack / Driver / Transport Decision着手前。
- S1開始を止める回答待ちはない。

## 2026-07-12: CP1 S1完了

- runtime、package manager、SQLite driver、Worker transport、test runnerを確定した。
- CP1の現在地をS2 Project Scaffold着手前へ進めた。

## 2026-07-12: CP1 S2完了

- rootに新実装のpackage、TypeScript build、test、format、module boundary scaffoldを追加した。
- Node.js 24とElectron 42同梱Node.jsでruntime persistence probeを確認した。
- CP1の現在地をS3 SQLite Bootstrap / Schema Verification着手前へ進めた。

## 2026-07-12: CP1 S3完了

- SQLite bootstrap、schema manifest検証、非対応DBの非破壊拒否を実装した。
- WAL / rollback journalを含む既存DBをsnapshot側で分類し、旧DB path aliasをopen前に拒否する契約を追加した。
- CP1の現在地をS4 Persistence Worker Lifecycle着手前へ進めた。

## 2026-07-12: CP1 S4完了

- Persistence Workerの世代付きprotocol、single FIFO、timeout / cancel、crash / shutdown lifecycleを実装した。
- 最大256 KiBのpayload chunk transfer経路とconstant-memoryのrequest replay拒否を追加した。
- CP1の現在地をS5 Repository Read Model着手前へ進めた。
- CP1 S5でscope付きbounded Repository read、opaque cursor、Message / payload chunk分離を実装し、現在地をS6着手前へ進めた。
- CP1 S6-Aでtyped write command、idempotency基盤、Session create / lifecycle transitionを実装し、現在地をS6-B着手前へ進めた。
- CP1 S6-B1で通常Run admissionを実装し、Message / Run / Attempt / Dispatch / Binding intent / IdempotencyRecordの一括commitを成立させた。
- CP1 S6-B2aでProvider Bindingのactive / ambiguous resolutionを実装し、ephemeral live ownershipをWorker memoryへ限定した。
- CP1 S6-B2bでDispatch共通Gate、送信intent、accepted / rejected / ambiguous resolutionを実装した。

## 2026-07-14: CP1完了

- S8 Integration Gateでpublic repository API、Main / Worker依存境界、clean install、Windows compiled smoke、SQLite sidecar cleanup、性能baselineを確認した。
- Node.js 24で全116 test、schema validator、runtime probe、lint、typecheck、build、formatを通し、materialなcorrectness / data-loss findingがないことを確認した。
- CP1を`完了`へ更新し、現在地をCP2 Application Service / CLI Control Plane着手前へ進めた。

## 2026-07-18: CP2 Session CLI control plane完了

- `ApplicationSessionOperations`の全Session操作を、version付きJSONと安定したexit codeを持つ`withmate session` CLIから実行可能にした。
- Sessionを主たる指定単位とし、Workspaceはcreate時に保存し、listの任意filterとして扱う契約へ統一した。
- caller supplied idempotency key、Application responseの明示的projection、Workerのstart / shutdown ownership、CLIからRepositoryへの迂回禁止を実行可能な契約で固定した。
- 全244 test、CLI process smoke、compiled persistence smoke、lint、typecheck、build、format、SQLite schema検証を通した。
- CP2全体は進行中のままとし、Run操作と後続control planeは別sliceで扱う。

### Accepted risks

| ID         | 発生条件と影響                                                                                                                            | 検知と復旧                                                                                             | 再判断条件                                                                                               |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| CP2-CLI-R1 | create時の`fs.stat`はOS I/O自体をcancelできないため、応答しないnetwork mountではoperation timeout後もprocessが残る可能性がある。          | 呼び出し元のprocess timeoutで検知し、対象processを終了できる。Session commit前でありデータ影響はない。 | network Workspaceをsupported scopeへ含める場合に、別processでの検証またはcancel可能な境界を検討する。    |
| CP2-CLI-R2 | base branchで作成されたpre-release schema v1 DBは、同じversion内のschema hash変更によりstartup時に拒否される可能性がある。                | startup failureとして検知できる。互換契約のない開発DBは再作成できる。                                  | schema v1の外部利用開始前、または既存DB保持がaccepted contractになった時点でmigration方針を決める。      |
| CP2-CLI-R3 | Windowsの通常path、extended-length path、UNC aliasはfile identityまで同一化しないため、同じdirectoryを別Workspaceとして扱う可能性がある。 | list結果のWorkspace path差異で検知でき、SessionはIDで引き続き操作できる。                              | file pickerや外部callerが複数のpath表現を渡す段階で、realpathまたはfile identityによる同一化を検討する。 |

## 2026-07-18: CP2 Session local-only delete CLI slice

- `withmate session delete`から、Session subtreeの主DB削除、Session Files削除、cleanup完了記録までをApplication Service経由で実行可能にした。
- `--confirm-local-only`を必須のvalueless CLI確認とし、Provider側のthreadまたはSessionを削除しないことをhelpへ明記した。
- primary commit後のcleanup失敗を、committed valueとcleanup tokenを保持する`partial_success`（exit code 10）として公開し、同一requestのexact retryでpending cleanupを再開する契約を追加した。
- busy subtreeの非変更、same-key/different-session競合、manifest page検証、Session Filesの固定root・symlink/junction拒否・missing時成功を実行可能なcontractで確認した。
- Session IDをRepository所有のincarnation identityへ変更し、通常Sessionとchild Sessionの両入口を同じallocatorへ統合した。削除後の通常create再送は別IDを発行し、旧delete再送が新incarnationを対象にしない。
- Session Files cleanupはRepository発行IDだけを内部入力として受け、検証済みrootへ作業directoryを固定したhelper processから相対削除する。manifest全体の検証が終わるまでfilesystem副作用を開始しない。
- CP2全体は進行中のままとする。Session Files orphan sweepと、process crashで残ったcleanupの自動探索・再開は後続sliceで扱う。

## 2026-07-19: CP2 Session delete review対応

- Session Files cleanupをDB所有application data directoryのidentityへ結び付け、親directory差し替え時にreplacement側を削除しない回帰contractを追加した。
- 通常writeとSession deletionのidempotency keyを共有claim registryへ統合し、cross-operation key再利用をRepositoryとSQLite schemaの双方向で拒否した。
- Session treeを4,096件に制限し、child admission、Repository delete、Application / CLI projection、schema manifestへ同じaggregate契約を展開した。
- subtree deleteをconnection-localなSQL worksetによるset-based削除へ変更し、関連ID群の全件hydrateを除去した。対象payload bytesと更新対象row数によるWAL見積りがdisk reserveを割る場合は、durable mutation前に`insufficient_disk_space`で拒否する。
- schema installは永続triggerを許可しつつ、transaction controlとTEMP schema objectをSQLite authorizerで拒否し、Worker connectionへschema artifactが残る経路を閉じた。

## 2026-07-19: CP2 Run observation control plane

- Provider非依存で成立する`ApplicationRunOperations`と`withmate run status|events|follow`を追加し、永続化済みRunの状態とbounded RunEvent pageをApplication Service経由で観測可能にした。
- followを1 invocation 1 responseのbounded long-pollとし、event、terminal closure、deadline、SIGINT abortを分離した。terminal status後のevent probe、opaque continuation、page / wait / poll上限を実行可能なcontractで固定した。
- Run statusとeventをallowlist projectionへ限定し、execution snapshot、Provider error code、内部ID、version、external side effect metadataをpublic出力から除外した。
- Run namespaceは既存`withmate-cli-v1`、exit code、stdout JSON、Workerのexactly-once shutdown契約へ追加した。CLI hard timeoutとSIGINTをbootstrap、operation、shutdownへ通し、parse / helpがruntimeを起動しないことをprocess smokeで確認した。
- production CLIには`start`、`retry`、active `cancel`を追加していない。Provider request / execution snapshotの構築、dispatch継続process、Provider interruptとterminal outcomeの相関を所有するruntimeが未確定である。
- Run observation sliceは完了したが、Provider runtime ownershipとmutation操作のcheckpoint帰属が未確定だったため、CP2全体は進行中のままとした。現在の帰属はD-006を参照する。

### Accepted risks

| ID         | 発生条件と影響                                                                                                                                                                                                                                                         | 検知と復旧                                                                                    | 再判断条件                                                                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| CP2-RUN-R1 | 将来live activity portをproductionへ接続した際、port rejectionまたはmalformed responseでは永続Run statusを取得済みでもApplication internal failureと`persistence.status='failed'`を返す。現行productionはdefault null portのため到達せず、データ破損や情報漏洩はない。 | structured failureとexit code 50で検知し、statusを再実行できる。永続Run stateは変更されない。 | CP3でlive activity portを接続する前に、補助表示を`null`へ縮退するか、persistence read済みのinternal failureを表せるenvelopeへ拡張するかを決定する。 |

## 2026-07-19: CP2 Run output control plane

- 長期判断は`docs/adr/012-run-output-control-plane.md`、public型は`src/shared/application-run-output-model.ts`、Applicationとfilesystem publicationの実行可能な契約は`test/application-run-output-service.test.ts`と`test/run-output-exporter.test.ts`を正本とする。
- `ApplicationRunOutputOperations`と`withmate run output-counts|outputs|output-preview|output-chunk|output-export`を追加し、永続化済みRun outputをApplication Service経由で扱えるようにした。
- Countsとitem pageをpayload BLOBから分離し、scope付きpoint readでpayload stateとredactionの組を検証する。TextとJSONは64 KiB previewと256 KiB chunkに制限し、binary本文はexplicit exportだけが消費する。
- ExportはCLI userが選んだabsolute destination grantをApplication side-effect boundaryへ渡す。Same-directory temporary fileへの逐次write、backpressure、lengthとSHA-256の照合、exclusive hard-link publishにより、既存destinationを上書きしない。
- Publicationは`published`、`not_published`、`unknown`を区別する。Timeout、cancel、helper response lossでpublish成否を確定できない場合は、destinationを確認してから再試行する。
- CLIは既存Run commandと同じJSON envelope、exit code、hard timeout、SIGINT、exactly-once shutdownを維持する。実DB smokeでcounts、list、preview、chunk、export、no-clobber、SQLite sidecar cleanupを確認した。
- Run output sliceは完了した。CP2にはSession Message timeline / content chunkとSession Run historyのApplication / CLI公開が残るため、CP2全体は進行中のままとする。

### Accepted risks

| ID                | 発生条件と影響                                                                                                                                                                                       | 検知と復旧                                                                                                                                      | 再判断条件                                                                                                                                               |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CP2-RUN-OUTPUT-R1 | Destination directoryを同じcurrent OS userの敵対processがexport中に置換した場合、pathname raceを完全には防げない。通常のidentity不一致は検知するが、敵対processに対するsecurity boundaryにはしない。 | Identity不一致またはpublication不明として検知できる場合は`unknown`を返し、destinationを確認してから再試行する。                                 | Sharedまたはuntrusted directory、別principal、adversarial local processをsupported scopeへ含める場合は、native directory handle相対operationを検討する。 |
| CP2-RUN-OUTPUT-R2 | Process crashまたは強制終了では、publish前またはpublish後cleanup前のsame-directory temporary fileが残る可能性がある。Destinationは既存fileを上書きしないが、temporary fileがdiskを消費する。         | 停止後に`.withmate-output-*.tmp`を確認し、export processが動いていないことを確認して削除する。Destinationの有無と内容を確認してから再試行する。 | Long-lived runtime、automatic retry、定期maintenanceを導入する場合は、temporary file ownershipとsafe sweepを設計する。                                   |

## 2026-07-19: CP2 / CP3 / CP5 scope再整理

- CP2はProvider非依存の永続control planeとし、残作業をSession Message timeline / content chunkとSession Run historyのApplication / CLI公開へ絞った。
- 単一SessionのRun `start` / `retry` / active `cancel`、supplemental input、approval / elicitation responseは、Provider dispatchとlive runtimeを所有するCP3へ移した。
- child Session / Delegationの`start` / `follow-up` / `message` / `wait` / `collect` / `cancel` / `kill`はCP5へまとめた。作成済みchild Sessionへの追加指示もCP5の対象とする。
- CP6はCP3で確定する共通Run operation contractへ依存させ、Session Files cleanupとRun output export temporary fileのorphan sweep / crash recoveryはCP8へ移した。
- 具体的なCLI operation名は未確定であり、CP3とCP5でApplication contractと同時に決定する。現在のCP2実装とpublic contractは変更していない。

## 2026-07-19: CP2 Run output review対応

- Destination directoryの解決とidentity検証をexport helperへ移し、中断通知後も終了しないhelperを猶予時間後に強制終了するよう変更した。非協調helperを使うprocess-level testで、owner processがhard deadline内に終了することを確認した。
- `payload_unavailable`をdiscriminated unionへ変更し、`pending`と`retryable: true`、それ以外のreasonと`retryable: false`だけをApplication型とCLI型で許可する。CLI projectorはraw responseの矛盾した組を両方向とも拒否する。
- Node.js 24.18.0で全407 test、SQLite schema validator、typecheck、build、Run CLI process smokeを通した。既定shellのNode.js 22.22.1ではruntime guardが意図どおりfail-fastすることも確認した。

## 2026-07-20: CP2 Session Message control plane

- 初期Message content blockをexact keysの`{ type: "text", text: string }`へ固定し、dense array、10,000 block、UTF-8 4 MiB上限を共有validatorで検証する。normal Run admission、Run terminal、supplemental input、child startの全write siblingを同じ境界へ集約した。
- `ApplicationSessionMessageOperations`へ`messages`と`messageContentChunk`を追加した。authorization後にSessionからinternal workspace scopeを解決し、Repositoryでworkspace / Session / Messageの組を再検証する。public pageはordinal順のopaque cursor、inline 64 KiB、bounded omissionを持ち、大きい本文とRunOutput / Provider payloadをhydrateしない。
- `withmate session messages`と`withmate session message-content-chunk`を追加した。CLIはApplication responseを再検証し、chunkのactual bytesから`nextOffset`を確認してbase64へ一度だけ投影する。help / parse failureのruntime非起動、既存exit code、timeout / SIGINT、exactly-once shutdownを維持する。
- 既存`smoke-cli-run.mjs`を拡張し、実DB上のuser / assistant Message、small-limit cursor、inline / chunked分離、base64長、actual offsetでの本文再構成、wrong scopeの`not_found`、RunOutput非混入、SQLite sidecar cleanupを確認した。
- public contractは`src/shared/message-content.ts`、`src/shared/application-session-message-model.ts`、対応するtype / testを正本とする。ADR 006とD-006のhydrate分離、cursor、CLI ownershipの判断は変えていないため、新規ADRと設計文書の更新は行わない。
- Node.js 24.18.0で全435 testとSQLite schema validator、runtime guard、format、module boundary / lint、typecheck、buildを通した。Session CLI、Run / Message CLI、compiled persistenceのprocess smokeもGreenで、SQLite sidecarが残らないことを確認した。
- Session Message sliceは完了した。CP2全体はSession Run historyと統合Gateが残るため、引き続き進行中とする。

## 2026-07-20: CP2 Session Run history control plane

- Repository readへSession / Workspace scope付きの`runs.page`を追加した。Run headerだけを`runs_session_ordinal_uq`によるordinal keysetで1 statement取得し、default 50 / maximum 100、opaque scope cursor、192 KiB response budget、ordinal付きomissionを適用する。execution snapshot、Message本文、RunEvent、RunOutput、RunAttempt、RunDispatch、ProviderBindingは取得しない。
- `ApplicationSessionRunOperations.runs`を追加した。`session_runs` authorization後にSessionからinternal Workspace scopeを解決し、Repository境界で再検証する。Run historyと既存Run statusは永続phase / failure / cancellation / timestamp projectionを共有し、completedでfinal assistant Messageがない組を含むphase-specific unionへ投影する。
- `withmate session runs --session-id <id> [--cursor <cursor>] [--limit <1..100>] [--timeout-ms <ms>]`を追加した。既存Session CLIのversion付きJSON、exit code、timeout / SIGINT、exactly-once shutdownを維持し、Application responseをstrict allowlistで再検証する。
- 実DB process smokeで、3件のRunのordinal page、small-limit cursor、別Sessionへのcursor流用拒否、completedかつfinal assistant Messageなし、historyとstatusのtimestamp一致、historyで得たRun IDからevents / outputへの遷移、internal field非露出、help時のruntime非起動、SQLite sidecar cleanupを確認した。
- Node.js 24.18.0で全459 testとSQLite schema validator、runtime guard、format、module boundary / lint、typecheck、buildを通した。Session CLI、Run / Message / Session Run history CLI、compiled persistenceのprocess smokeもGreenだった。
- public contractは`src/shared/application-session-run-model.ts`、共有phase projection、対応するtype / testを正本とする。既存ADR 006 / 011とD-006のauthorization、projection ownership、CP2 / CP3 / CP5分離を変更していないため、新規ADRとdesign文書の更新は行わない。
- Session Run history sliceは完了した。CP2全体は次の`test/cp02-control-plane-gate`による統合Gateが残るため、引き続き進行中とする。

## 2026-07-20: CP2 Control Plane統合Gate完了

- Session createからMessage timeline、Session Run history、Run status / events / follow、output counts / list / preview / chunk / exportまでを、Providerを起動せずproduction CLIで辿った。large Messageとtext / JSON outputはactual byte offsetで再構成し、binary outputはexplicit exportだけで公開した。
- owner / scope、opaque cursor、192 KiB page budget、64 KiB inline / preview、256 KiB chunk、4 MiB Message上限、16 / 64 MiB output quota、payload非hydrate、strict allowlist projectionを、Application、Repository、CLI contractと実DB smokeへ対応付けた。
- exact retry、same-key / different fingerprintまたはoperationのconflict、Session incarnation、commit応答喪失後のsame identity replay、`effect: "unknown"`と`reconciliation: "exact_request_required"`の組を既存Application、Repository、Worker contractで確認した。同じfailure timingを重複するtestは追加していない。
- 独立Gate evidence reviewで、Session renameの構造的Repository write bypassをmodule-boundary checkerが検出できない`blocking` findingを確認した。Session writeの5操作を同じ禁止capability集合とnegative fixture health checkへ揃え、修正前のRed、修正後のGreen、targeted re-review findingなしで閉じた。
- Node.js 24.18.0でruntime guard、format、lint、typecheck、全459 testとSQLite schema validator、buildを通した。build後のSession CLI、Run / Message / Session Run history CLI、compiled persistenceのprocess smokeもGreenで、SQLite sidecarとSession Files cleanup artifactが残らないことを確認した。
- 既存accepted riskのCP2-CLI-R1からR3、CP2-RUN-R1、CP2-RUN-OUTPUT-R1からR2は、発生条件、影響、検知、復旧、再判断条件が引き続き妥当である。Gateではnetwork Workspace、path aliasのfile identity化、live activity port、adversarial directory、schema migration、temporary file orphan sweepをsupported scopeへ追加していない。新しいrisk-candidateと未実行のGate validationはない。
- 既存ADR 003 / 006 / 011 / 012とD-006の責務、failure、checkpoint分離を変更していないため、新規ADRとdesign文書の更新は不要と判断した。CP2を`完了`とし、現在地をCP3着手前へ進めた。CP3は`未着手`のままで、Q-11は回答していない。

## 2026-07-20: CP3 Codex runtime contract確定

- `codex-cli 0.144.6`とNode.js 24.18.0を使用し、stable / experimental schemaをrepository外へ生成した。stable 267 file、experimental 337 fileで、`turn/steer`、`turn/interrupt`、agentMessage phaseはstable schemaに存在した。
- 隔離した一時workspace、read-only sandbox、approval=neverで`runtime-contract-probe.mjs`を2回実行した。CAS-009は空interrupt response、Thread idle、`turn/completed(interrupted)`の順、CAS-010はTurn不一致とactive Turn不在の拒否、同一Turnへのsteer受理とuser Message履歴反映、CAS-016は`commentary` 1件と`final_answer` 1件を両回で確認した。
- CAS-017はWindowsでCodex daemon lifecycleが非対応のため`blocked`とした。既存daemonのinstall、start、stop、restart、設定変更は行っていない。WebSocketは公式資料でexperimental / unsupportedのため代替transportとして採用していない。
- ADR 013で、CLIやWindowから独立した長寿命WithMate runtime hostを1 current OS user / 1 application data rootのownerとした。runtime hostがPersistence Worker、stdio App Server child、live Run、draft、interactionを所有し、operational CLI / GUIはOS-local IPC clientとする。
- public operation名を`withmate run start`、`withmate run retry`、`withmate run send-input`、`withmate run cancel`に確定した。`pending`だけを安全な自動送信候補とし、`dispatching` / `ambiguous`を自動再送せず、Provider履歴から欠落Message / RunEvent / draftを推測生成しない。
- Q-11を確認済みとし、CP3を`進行中`へ更新した。このsliceはproduction source、schema、CLI commandを実装していない。次のproduction branchは`feat/cp03-runtime-host`とし、runtime host、single-owner起動、local IPC、既存operational CLI compositionの移行から開始する。

### Accepted risks

| ID             | 発生条件と影響                                                                                                                                                                                                                              | 検知と復旧                                                     | 再判断条件                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| CP3-RUNTIME-R1 | CAS-010の履歴反映を確認するためpersistent Threadを作成する。repository外workspaceの削除後も、syntheticなThreadが設定済みCodex profileへ残る可能性がある。既存Thread、repository data、secretは変更せず、Thread IDと本文を証跡へ出力しない。 | CodexのThread一覧で検知し、不要なら対象Threadをarchiveできる。 | 隔離したProvider stateで認証を安全に利用できる手段、または作成Threadを確実に削除できるstable APIが利用可能になった時点でprobeを更新する。 |

## 2026-07-20: CP3 Codex App Server stdio transport

- 新しいユーザー指示に基づき、runtime hostより先にCodex App Server transportを独立実装した。ADR 013のowner判断は変更せず、transport instanceとchild processの最終ownerは後続runtime hostのままとする。runtime host、local IPC、Application composition、Provider固有のThread / Turn / item変換は実装していない。
- `src/main/providers/codex/`へ、`codex app-server --stdio`のprocess ownership、incremental UTF-8 JSONL framing、strict outer envelope validation、request correlation、server request / notification routing、`initialize` / `initialized` handshake、deadline / abort、bounded closeを配置した。後続hostとAdapterが利用するsurfaceは同directoryの`index.ts`へ限定し、framer、wire writer、protocol sessionは内部実装のままとした。
- 公開failureは、送信前の`request_not_sent`、送信後の`response_unknown`、remote error codeだけを持つ`remote_error`、connection / protocolの`connection_failure`へ分離した。active writeとqueued writeの終了順を分け、closeまたはstdio failureでもactiveはoutcome unknown、未送信queueはpre-send rejectionとして一度だけ収束する。transportによる自動retryは行わない。
- default resource limitは、protocol line 1 MiB、pending request 128件、retired unsent client request ID 4,096件、outstanding server request 128件かつIDのUTF-8合計256 KiB、queued event 128件、queued write 2 MiB、stderr retention 64 KiBとした。settled server request IDは保持せず、長寿命connectionのlifetime capにしない。未送信IDの相関記録が上限へ達したconnectionは、安全なsent / unsent判定を失う前にprotocol failureへ収束する。stderrは件数とbyte数だけを保持し、raw text、secret、account情報、private pathをdiagnosticへ投影しない。
- framing、correlation / handshake、process lifecycle、integrated boundaryの各sliceをtargeted contract testと独立reviewで閉じた。reviewで確認したduplicate JSON member、handshake terminal error、server request ID lifetime、cleanup rejection、active / queued write outcome、server responseのpre-send retry、終了後のowned process参照保持をsourceとexecutable contractへ展開した。
- 2026-07-21のcomplete-diff reviewで、process tree残留、受信済みevent消失、stdout drain前の終了判定、未送信queueの誤分類、initialization sequenceのdeadline / abort漏れ、spawn前validation漏れを確認して修正した。root先行exit、queued request cancellation、clientInfoとresource limitの複合値を対象としたclosure reviewとtargeted re-reviewを行った。
- 後続reviewで、未送信request IDへのresponse受理、root終了後のWindows process tree再探索、未処理stderr error、JSON-RPC 2.0 responseのversion欠落、settled server request IDのlifetime保持を追加確認し、同じcontract familyへ展開して修正した。WindowsはADR 014に従い、起動待ちsupervisorを割当後にCodexをspawnするJob Object ownershipへ変更した。PID再探索は廃止し、中間launcher終了後のdescendant回収と無関係processの非干渉をprocess testで確認した。
- 独立closure reviewで、timeout / abortまたはpre-send write rejectionによりsettle済みとなった未送信IDへのresponseがlate anomalyへ誤分類される兄弟sequenceを確認した。未送信IDをboundedにretireし、response受理または相関上限到達をprotocol failureへ収束させた。response先行、settle先行、write rejection、resource cap、close / fail cleanupをtargeted re-reviewし、未解決のblocking / risk-candidate findingはない。
- 最終reviewで、sparse executable argumentsの検証迂回とNode timer上限超過値の1ms丸めを確認した。argumentsはdense own indexとread-once snapshotを外部process起動前に検証し、未指定時だけdefaultを適用する。startup、close、handshake、requestのtimeoutは1から2,147,483,647msへ統一し、wall-clock巻き戻り後のremaining durationも同じ範囲へclampする。changing accessor、options getter、null、exact maximum、maximum超過をcontract testへ追加し、targeted re-reviewで未解決のblocking、risk-candidate、validation gapがないことを確認した。
- Node.js 24.18.0でruntime guard、format、module boundary / lint、typecheck、build、SQLite schema validator、Codex transport targeted 69 test、Koffi経由のJob Object作成、実Codex 0.144.6へのinitialize-only smokeを通した。全532 testもGreenで、runtime dependencyのauditは0 vulnerabilities、新しいaccepted riskはない。

## 2026-07-22: CP3 Codex App Server Adapter

- `codex-cli 0.145.0`のstable schemaをbaselineとし、model catalog取得、Thread開始・再開・読取、Turn開始・steer・interruptを型付きAdapter operationとして実装した。approvalは`never`に固定し、request送信前、送信済み、Provider拒否、response不整合のeffect certaintyを分離して自動retryを行わない。
- responseとnotificationを単一のThread / Turn lifecycleへ収束し、completed / failed / interruptedを単調なterminalとして扱う。duplicate、out-of-order、遅延response、terminal先行をbounded stateとtombstoneで処理し、別Threadまたは別Turnのstateへ混入させない。
- agent Messageの`commentary`、`final_answer`、phase unknown fallback、plan、reasoning、operation、未対応itemをbounded outputへ変換した。Provider terminal outcome、final assistant Message、content failureを分離し、operation raw payload、private path、secret、大きいunknown payloadをpublic eventまたはdiagnosticへ投影しない。
- connection / Thread / Turn / item / event queue / text / diagnosticのaggregate limitをprospectiveに検証し、known-invalid event、unsupported server request、protocol anomaly、resource超過を診断後のconnection failureへ収束した。closeはidempotentで、pending waiter、lifecycle、item、retained textを解放し、event pump自身をawaitしない。
- production `CodexAppServerTransport`からAdapterまでのprocess-level contractを追加し、initialize後のstable model catalogを実process境界で取得した。runtime host、Application / Persistence composition、Run dispatch、approval / elicitation interaction、CLI operationはこのsliceに含めず、CP3は進行中のままとした。
- Node.js 24.18.0でAdapter targeted 101 test、全622 TypeScript test、runtime guard、format、module boundary / lint、typecheck、buildを通した。`npm test` wrapperは全620 TypeScript testがGreenになった後、Windows `py -3` launcherがインストール済みPythonを検出せずexit 1となることを確認した。追加contractを含む全622 TypeScript testを`tsx`から再実行し、同じSQLite schema validatorをインストール済みPython 3.12から直接実行してGreenを確認した。全体spec実行では既存export timeout testが一度だけtiming差で失敗したが、対象testの単独再実行と後続の全622 test再実行はGreenだった。
- complete diffの独立reviewで、Turn output aggregate、stable notification分類、stable schemaのoptional field、model / reasoning tuple、IDなしunknown notification、terminal先行tombstoneの6 familyをblockingと判定した。closureではstable schemaのaudio / webSearch / MCP exactness、Turn response / admission、pending owner、catalog load中のclose / failureへ同じinvariantを展開して修正し、targeted re-reviewで未解決のblockingとrisk-candidateがないことを確認した。
- fresh-context closure reviewでは、active Turnに相関しないusage / error、未確定ThreadへのTurn送信、steer / interruptのactive tuple、modelのtext modality、Thread mutationのpending aggregate、notification / response race、steer acknowledgement、stable reasoning effort、design上のoperation scope、履歴内の重複Turn / item IDへ反例を展開した。response-confirmed Threadだけをadmissionに使い、modelの明示選択と既存history継続を分離し、曖昧なThread / Turn mutation ownerをcloseまで保持するexecutable contractへ揃えた。重複IDは共有decoderで拒否し、readは`invalid_response`、送信済みmutationは`ambiguous`へ収束させた。
- 既存ADR 013と`docs/design/codex-app-server-adapter-contract.md`がowner、failure、mappingの判断理由を所有しており、新しい長期判断は追加していない。修正後のtargeted re-reviewで未解決のblockingとrisk-candidateがないことを確認し、新しいaccepted riskはない。
- `codex-cli 0.145.0`のnotification envelopeにある`emittedAtMs`をexact validationへ追加し、production transportのprocess contractで未知notificationを受信しても接続を維持することを確認した。未知notificationの`provider_metadata`とdiagnosticには同じThread / Turn / item相関tupleを投影する。
- active Threadのresumeでは唯一の`inProgress` Turnをcurrent active tupleとして復元し、二重Turn開始を拒否したうえでsteer / interruptを既存Turnへ相関する。Thread statusとcurrent Turnが矛盾するresponse、またはnotificationとresponseのID競合では候補を選ばず`ambiguous`へ収束させる。
- Thread / Turn開始notificationまたはinterruptのterminal notificationで副作用を観測した後に対応requestが`remote_error`となった場合は、`effect: none`へ戻さず`ambiguous`へ収束させる。Provider未送信を証明できる`request_not_sent`は、無関係なnotification観測があっても`effect: none`を維持する。受理済みTurnのmodel overrideはThreadのcurrent modelを更新し、後続Turnのcapability検証へ反映する。
- 追加の独立reviewでは、Thread開始、Turn開始、interruptのnotification-first矛盾とID競合を同じinvariant familyへ展開した。修正後のtargeted re-review 44 testを通し、未解決のblockingとrisk-candidateはない。実App Serverにおけるsteerのnotification先行順序とactive Thread resume時の既存item再配信は未実測であり、`docs/design/codex-app-server-adapter-contract.md`のruntime検証Gateとして残した。
- fresh-context complete-diff closure reviewでは、notification先行model overrideの未送信rollback、terminal前後をまたぐnotification / response Turn ID不一致、current Turnを相関できない`active` Threadの送信Gateをblockingと判定した。暫定modelはpending owner identityで管理し、`request_not_sent`では同じownerだけを元のcurrent modelへ戻す。Turn IDはlifecycle受理前に観測し、terminal後もresponseと直接照合する。`active`のままcurrent TurnがないThreadへは新しいTurnを送らない。
- targeted closure reviewで、古い`request_not_sent`と新しい同一model ownerの競合、terminalから遅延した`turn/started`後の別response IDへ同じinvariantを展開した。model値が同じ場合も新ownerへtagを移し、遅延notificationのIDはlifecycleで拒否されてもpending ownerへ保持する。修正後のtargeted reviewで未解決のblockingとrisk-candidateはなく、新しいaccepted riskはない。
- 追加reviewで、steer入力の配送相関、event queue内のterminal保持、Thread status別のTurn開始Gate、Windows Workspace identity比較をblockingと判定した。`turn/steer`へ`clientUserMessageId`を付与して`userMessage.clientId`と相関し、配送観測後の失敗を`effect: none`へ戻さない。accepted response後もownerをmatching notificationまたはterminalまで保持し、別Turnでの観測は両Threadのmutation admissionを`ambiguous`へ閉じる。
- event queueは、terminalを追加するときも既存terminalを削除せず、削除可能なnon-terminal eventがなければconnection failureへ収束する。Turn開始はcurrent Turn不在かつThread statusが`idle`の場合だけ許可する。Thread開始・resume responseの`cwd`はdisplay文字列ではなく共有Workspace identity keyで相関する。
- 修正後はAdapter / Wire targeted 107 test、全628 TypeScript test、runtime guard、format、module boundary / lint、typecheck、build、SQLite schema validator、diff checkを通した。全体testでは既存Application deadline testが一度だけtiming差で失敗したが、単独再実行と後続の全628 testはGreenだった。`npm test` wrapperのWindows `py -3` launcher問題は既知のvalidation gapで、同じschema validatorをインストール済みPython 3.12から直接実行してGreenを確認した。
- 独立targeted reviewで、accepted steer response直後にownerを破棄してresponse-firstの後続notificationを相関できないblockingを確認し、settled ownerの保持とterminal / failure / closeでのbounded cleanupへ修正した。targeted re-reviewでは未解決のblockingとrisk-candidateはなく、新しいaccepted riskとADR判断は追加していない。
- `codex-cli 0.145.0`からstable JSON Schemaを再生成し、modelの`inputModalities`とagentMessageのnullableな`phase`が省略可能で、それぞれ`["text", "image"]`と`null`の既定値を持つことを確認した。decoderはfield欠落時だけschema既定値を適用し、明示された不正値はresponse境界で拒否する。
- `thread/resume`のpending ownerを、同じThread IDの`thread/started` notificationと相関する。notification受理後の`remote_error`は`ambiguous / effect: unknown`へ収束させ、`request_not_sent`は`effect: none`を維持してownerを解放する。独立targeted reviewで確認した、resume#1の`request_not_sent`後にresume#2のnotificationがlifecycle上のduplicateとなる反例も、mutation evidenceをduplicate判定前に記録して閉じた。
- 修正後はAdapter / Wire targeted 115 test、全636 TypeScript test、runtime guard、format、module boundary / lint、typecheck、build、SQLite schema validator、Markdown format、diff checkを通した。独立targeted re-reviewで未解決のblockingとrisk-candidateがないことを確認した。既存の設計契約を厳密化した変更であり、新しいADRとaccepted riskは追加していない。`npm test` wrapperの既知のWindows `py -3` launcher問題は変わらないため、TypeScript testとschema validatorを個別に実行した。
- 追加reviewで、Thread notification / responseのWorkspace・persistence相関、signed int32の`commandExecution.exitCode`、最新requestへ置換されるtoken usage `last`、interruptと全terminal statusの競合をblockingと判定した。Thread相関tupleへWorkspace identityとephemeral modeを含め、`exitCode`をnullable signed int32として検証し、usageは`total`だけを前回値と単調比較する。pending interruptの対象Turnで`completed`、`failed`、`interrupted`のいずれかを観測した後の`remote_error`は`ambiguous`へ収束させる。
- response-firstのThread identity不一致後は、そのThreadをquarantineし、非同期capability validation後かつProvider send直前にも再確認する。`turn/start`とmodel指定の`thread/resume`の両入口で、競合中のmutationを未送信へ収束させる。
- 修正後はAdapter / Wire targeted 122 test、全643 TypeScript test、runtime guard、format、module boundary / lint、typecheck、build、SQLite schema validator、diff checkを通した。今回は`npm test` wrapperからSQLite validatorまでGreenとなり、直前の作業で記録したWindows `py -3` validation gapは現在の環境では再現しなかった。独立targeted re-reviewで未解決のblockingとrisk-candidateがないことを確認した。既存のAdapter契約を厳密化した変更であり、新しいADRとaccepted riskは追加していない。
- 追加reviewで、`turn/started`を伴わないterminal-first Turnが`remote_error`後に`effect: none`へ戻る問題と、`thread/resume`のeffect unknown ownerを保持しながら同じThreadへTurn mutationを送信できる問題をblockingと判定した。pending `turn/start`は未観測のTurn IDを持つterminalも副作用証拠として記録し、以前に受理済みのterminal duplicateは新しいrequestへ相関しない。同じThreadに未解決のThread mutation ownerがある間は、`turn/start`、`turn/steer`、`turn/interrupt`を送信しない。
- 修正後はAdapter / Wire targeted 128 test、全649 TypeScript test、Node.js 24.18.0のruntime guard、format、module boundary / lint、typecheck、build、SQLite schema validator、Markdown format、diff checkを通した。独立targeted reviewで未解決のblockingとrisk-candidateがないことを確認した。
- 追加reviewで、response確定済みThreadの遅延`thread/started`を後続のpending `thread/start`へ誤帰属する問題と、`turn/steer`の`response_unknown`後に配送相関ownerを破棄する問題をblockingと判定した。response-confirmed Thread IDへの通知は既知Threadへ収束させ、別のpending startへ副作用証拠として渡さない。ambiguous steerのclient ID ownerはmatching `userMessage`または対象Turnのterminalまで保持し、遅延したtuple競合を検出する。terminalがresponseより先に到着した場合は、response settle時にownerを解放する。
- 修正後はAdapter / Wire targeted 132 test、全653 TypeScript test、Node.js 24.18.0のruntime guard、format、module boundary / lint、typecheck、build、SQLite schema validator、Markdown format、diff checkを通した。独立targeted reviewでは、ambiguous steerのmatching deliveryによるowner解放も専用testへ追加し、未解決のblocking、risk-candidate、validation gapがないことを確認した。
- test contract reviewで、public summaryとAdapter close errorの英語文言を完全一致していたassertをblockingと判定した。diagnostic code、分類、相関tuple、completion state、payload、redactionは直接検証したまま、summaryは非空、UTF-8 byte上限、既知の非公開値を含まないことを共有assertionで検証する。closeは文言ではなくrejectする契約だけを固定する。
- request optionsのsnapshot testは、別identity、freeze、呼出直後に元objectを変更しても送信済みtimeoutとsignalが変化しないことを検証する。既存のsnapshot境界がこのcontractを満たしたため、production sourceは変更していない。修正後はAdapter / Wire targeted 132 test、全653 TypeScript testとSQLite schema validator、Node.js 24.18.0のruntime guard、format、module boundary / lint、typecheck、build、diff checkを通した。
- 独立targeted reviewで、unknown notification、warning、error、late error、known-invalid payload、通常methodのunsupported server requestにsummary安全性と構造化fieldの兄弟assertionが不足しているblockingを確認した。同じ共有assertionへ揃え、code、method、correlation、willRetry、redactionを各経路で直接検証する。最終差分でAdapter / Wire targeted 132 test、全653 TypeScript testとSQLite schema validatorを再実行し、targeted re-reviewで未解決のblocking、risk-candidate、validation gapがないことを確認した。

## 2026-07-26: CP3 production runtime hostとoperational CLI移行

- 1 current OS principal / 1 canonical application data rootをowner tupleとする長寿命runtime hostを実装した。Windows named pipeまたはUnix domain socketのfail-closedなlocal authorization、single-owner claim、世代付きhandshakeを確立してから、1世代のPersistence Worker、Session Files、既存Application Serviceをhost内で構成する。
- version付きinternal JSONL protocol、exact validator、binary codec、operation allowlist、per-connection / host aggregate resource limitを追加した。client authorizationは受け付けず、hostがlocal authorizationを注入する。IPC request IDはconnection correlationだけに使い、domain idempotency keyを置き換えず、response loss後の自動retryを行わない。
- 既存21 operational operationをruntime IPC clientへ移行し、production CLIからone-shot Application / Persistence compositionへ到達する経路を削除した。help、version、parse failure、confirmation不足はruntimeを起動せず、CLI lifecycleのshutdownはclient connectionだけを閉じる。
- compiled process smokeで、同時host起動が1 ownerへ収束すること、別CLI processが同じgenerationを共有すること、forceful crash後に新generationが同じDBのSessionを読めること、graceful stop後にWorker checkpoint、endpoint解放、SQLite sidecar cleanupが完了することを確認した。test cleanupは起動時に保持したchild handleだけを対象とし、production stop commandは追加していない。
- compiled Application compositionのimport graphでProvider起動経路がないこと、module-boundary checkでproduction CLIのdirect Application / Persistence fallbackがないことを確認した。Run mutation、Codex Adapterのproduction接続、Provider dispatch、startup reconciliation、schema変更は行っていない。
- Node.js 24.18.0でruntime targeted test、全716 testとSQLite schema validator、runtime guard、format、module boundary / lint、typecheck、build、runtime host / Session CLI / Run CLI / compiled persistenceの各process smokeを通した。Windowsのnamed pipe、ACL、同時起動、detached host、crash recovery、graceful cleanupは実processで確認した。Unix socketの実process permission検証はWindows環境では未実行で、platform-independentなUnix metadata / error classification contractだけを確認した。absent endpointからのcompiled CLI bootstrapは、unit bootstrap、production detached spawn、compiled CLI接続へ分解して検証しており、単一process smokeとしては未実行である。
- 各sliceの独立targeted reviewを実施した。Slice 6では、同時spawnの部分成功、controlled shutdown IPC送信失敗、CLI timeoutの各経路でowned childのexit確認前にtemporary artifact cleanupへ進み得るblockingを同じfailure timing familyとして修正した。修正後のprocess smokeはpartial spawn、graceful stop failure、IPC send failure、CLI hangを決定的に再現し、回収不能時はartifactを削除せずcleanup failureを表面化する契約を確認した。targeted re-reviewで未解決のblockingとrisk-candidateはない。
- initial complete-diff reviewでは、durable writeのresponse lossがRuntime Application proxyから例外として漏れ、CLIで`effect: unknown`と`exact_request_required`を失うblockingを確認した。transport execution certaintyをApplication failureへ写像し、durable write、read、exportとpublic CLI projectionの回帰contractを追加した。
- fresh-context complete-diff closure reviewでは、shutdown deadline後に未収束のdurable requestを残してowner claimを解放できるblockingを確認した。caller boundaryとcanonical ownership finalizationを分離し、durable Application operation、Application shutdown、listener / connection cleanupの完了後だけclaimを解放する。slow response writeはApplication settlementと分離し、clientがresponseを読まなくてもlistener closeで中断してownership cleanupを進める。修正前Redと修正後Greenを確認し、targeted closure reviewで未解決のblockingとrisk-candidateがないことを確認した。
- 後続reviewでは、Session createの同一Workspaceを表すrequest / resultが文字列表現の差でIPC response validationに拒否されるblockingと、Persistence Workerのstartup failure時にWorker exit確認前にowner claimを解放できるblockingを確認した。Workspaceはhost path identityで相関し、別identityと非canonicalなresultは拒否する。Worker startupのtimeout、abort、`startupFailed`、crashは同じexit-confirmed failure境界へ収束させ、終了を遅延させたWorkerが残る間は競合claimを`busy`に保つ。修正前Redと修正後Greenを確認し、targeted closure reviewで未解決のblockingとrisk-candidateがないことを確認した。
- Windows named pipeの追加reviewでは、clientがserverのowner / DACL確認前に`SecurityImpersonation`を許可するblockingと、Application startup中に切断したreadiness clientをfatal accept errorとしてhost全体を終了するblockingを確認した。client SQOSをidentityとprivilegeの照会だけを許す`SecurityIdentification`へ制限し、server側のcurrent principal照合は維持した。accept前に切断済みとなったpipe instanceはconnection-localな終了として閉じ、first-instance排他を再確認した新しいinstanceでacceptを継続する。独立reviewで確認したpre-aborted acceptの見落としも、待受instanceを消費する前のabort再確認へ揃えた。修正前Redと修正後Green、後続handshake、Windows ACL / capacity / close / abort / first-instance排他を確認した。
- 最終reviewでは、ready後のPersistence Worker crashでruntime hostが壊れた世代のendpointとclaimを保持し続けるblockingと、Unix listenerがaccept前に切断したconnectionを待機queueへ保持するrisk-candidateを確認した。Worker clientはfatal stateへの遷移時にrequestを失敗させつつ、Worker exit確認後だけowner Applicationへfatal lifecycleを通知する。fatal stateでのshutdownもexit前にはsettleさせない。runtime hostは同じcanonical finalizationへ入り、Application shutdown結果にかかわらずlistenerとclaimを解放して、新しいclient / generationを開始可能にする。Unix listenerはactive connectionとaccept待ちqueueを同じregistryで所有し、close時に両aggregateから参照を除去する。終了を遅延させたWorker、競合claim、ready後のhost finalization、pre-accept disconnectの回帰contractを追加し、未解決のblockingとaccepted riskはない。
- endpoint ownershipとpublic operation boundaryは既存ADR 013が所有する。wire fieldとvalidationはtype / executable contractを正本とし、新しいADR、schema変更、accepted riskは追加していない。

## 2026-07-27: CP3 Run start / retryとCodex production dispatch

- `ApplicationRunOperations`へRun start / retryを追加した。startはmodel、reasoning effort、sandboxの明示を必須とし、retryはsource Runのexecution snapshotを既定値として、指定された項目だけを上書きする。Provider、Workspace、approval、Characterはcallerから受け取らない。
- RepositoryはMessage、Run、Attempt、Binding identityを発行し、admission、capacity、idempotency fingerprintを一つのtransactionで確定する。exact replayは保存済みphaseを返し、未確定または別fingerprintのrequestを新しいProvider mutationとして実行しない。
- runtime host内でCodex Provider processを遅延起動し、Binding作成またはresume、Dispatch、output、final Message、terminal eventを一つのowner tupleへ相関した。Provider process failureは受理済みRunを`interrupted`へ収束させ、runtime hostと別Sessionの永続操作を継続する。
- internal IPCとCLIへ`run start` / `run retry`を追加した。client disconnectやresponse lossはdurable writeをcancelせず、CLIはeffect unknownを自動再送しない。再送には同じdomain idempotency keyと同じrequestが必要である。
- deterministic fake Codex processを使うcompiled process smokeを追加した。隔離したapplication data rootで、通常start、host再起動後のterminal exact replay、retry、response loss後のexact replay、同時Session、client disconnect後のRun継続、Provider process failure、graceful shutdownを確認した。production profile、既存DB、実Codex executableは使用していない。
- public capacity errorから内部Provider identityを除外し、fresh admissionは`queued`だけを返し、exact replayだけが保存済みphaseを返せる契約へ揃えた。Application、runtime IPC、CLIの各境界で不正なreplay stateとphase tupleを拒否する。
- Codex processの`initialize`で得た`userAgent`をschema baselineと照合し、不明または非対応versionではAdapter operation前に接続を閉じる。fake process smokeで非対応versionが`model/list`、Thread、Turnへ到達せず、後続の対応versionで新しいgenerationを開始できることを確認した。
- Dispatchの受理が`ambiguous`な間は自動再送せず、同じProvider executionを照合できるgenerationを失った時点で、外部副作用の不確実性とDispatch stateを保持したままRunを`interrupted`へ収束させる。terminal response lossでは同じfrozen commandだけを再試行し、Sessionとcapacityのownerはterminal commit後に解放する。
- modelとreasoning effortの組をThread作成・再開前にcapability検証し、未対応の組でProvider Threadを変化させない。Session projectionのWorkspace key / canonical pathをApplicationで再照合し、RepositoryとAdapterは同じ32,768文字境界を使う。identifier向けの文字数またはUTF-8 byte上限をWorkspace pathへ誤適用しない。
- Application / RepositoryのMessage上限であるUTF-8 JSON 4 MiB / 10,000 blockをCodex Adapterの`turn/start` / `turn/steer`でも維持する。Sessionが受理するworkspace path / additional directories、Message、JSON escape、App Serverの`text_elements`とwire envelopeの複合上限を共有定数から導出し、execution snapshot、Provider request、stdio line、queued writeの各境界で合法な組を狭めない。runtime IPC / CLIのinline上限は64 KiB / 4,096 blockのままである。
- durable admission後の一時的なread失敗と、Provider Thread受理後のBinding resolution不明では、runtime hostが同じownerとfrozen commandを保持してread-backを再試行する。shutdownも未完了ownerを一度ずつ再駆動し、一時障害から回復した後の再shutdownでRunを終端化できる。event consumer失敗時はProvider connectionをcloseしてからgenerationを解放し、旧generationの遅延eventを遮断する。
- Dispatch beginが`queue_full`または`worker_closing`のretryableな`effect: none`で失敗した場合も、Providerへ送信せず、同じfrozen commandとRun ownerを保持する。in-flight workと重なったexact replayは、work完了後に新しく登録されたpending Dispatchだけを再駆動する。shutdownはin-flight workのsettlement後にもDispatch ownerをflushし、transientなPersistence Worker failureによってadmission済みRunを`queued`のまま放置しない。
- RunOutput writeの効果が不明な間は後続outputをcommitせず、受信順と永続ordinalを維持する。eventまたはoutput上限を超えたRunには`runtime_resource_limit`のterminal diagnosticを残し、保存欠落を正常成功として隠さない。
- Dispatch begin、Provider送信前のrejected resolution、accepted / ambiguous resolution、RunOutput、terminal commandの永続化が一時失敗した場合は、Provider eventの再受信やpublic requestの再実行へ依存せず、runtime hostがfrozen commandのpersistence-only retryを自動継続する。shutdown中にcontext readが完了したRunも未送信terminalへ収束させ、durable ownerを取り残さない。
- Provider connectionはclose完了後だけgenerationを解放する。Adapter、transport、process group、native handleは失敗したclose結果を成功扱いせず、同じownerを保持して再試行する。Windows Job Objectの設定、process割当て、一時process handle解放でpartial acquisitionとなった場合もcleanup ownerをtransportへ引き渡し、同じJob / handleをclose成功まで再試行する。Adapter公開前のstartup cleanupもfactoryが保持し、close成功までsuccessor processを開始しない。shutdown中のclose失敗はpendingとしてruntime hostのclaimを保持する。ambiguousなThread作成・再開もRun収束後にgenerationを退役させ、Adapter内のmutation reservationを次のRunへ持ち越さない。
- retry snapshotへmodelの`explicit` / `inherited`を記録する。継承時はsource Runのmodel値とprovenanceをAdapterまで渡し、同じThreadの後続Runがmodelを変更していてもsource Runの値へ戻す。hidden historyは新規選択ではないため`selectable`を要求しないが、catalog上の存在、入力modality、reasoning effortは検証する。Workerは通常startのexplicit model、retryのsource Run model、Session Workspace、Message / snapshot / Provider requestの複合不変条件をadmission transactionで再検証する。
- fresh-context complete-diff reviewでは、Provider送信前の決定的失敗を`failed`としてterminal化するRuntimeと、その組を拒否するWorkerの不一致を確認した。`binding_creation_not_sent`と`dispatch_not_sent`は`failed`、`canceled`、`interrupted`を原因に応じて受理し、Binding、Dispatch、Run、Attempt、terminal eventを同じtransactionで収束させる。実Workerを使ったunsupported Providerの回帰contractでterminal phase、Session解放、次Run admissionまで確認した。
- 同reviewでは、model省略retryのdurable snapshotがsource Runのmodelを保持する一方、Provider実行がcurrent Thread modelを使う不一致も確認した。Adapter入力へmodel provenanceを追加し、`thread/resume`と`turn/start`へsource modelを指定する。`A -> B -> retry A`のThread履歴とhidden source modelを回帰contractへ追加し、明示されたhidden modelは引き続き拒否する。
- 後続のtargeted reviewでは、Binding owner上限到達を決定的なApplication failureではなく`interrupted`へ分類する不一致を確認した。Thread作成と再開の両経路を`dispatch_not_sent`、`failed`、`application`へ揃え、Provider Turnを送らずにterminal化することを、実際に`maxTrackedBindings`を飽和させて確認した。
- 最終closure reviewでは、Thread mutationの`not_sent / invalid_input`を処理段階だけで`interrupted`へ分類し、Turn mutationのshutdown中`not_sent / aborted`を`failed`へ分類する不一致を確認した。Provider mutationの結果codeと、結果を最初に観測した時点のshutdown / transport contextを共有classifierで判定し、永続化再試行中に後からshutdownが到来しても分類を変更しない。Thread作成・再開の決定的入力失敗は`failed / application`、送信前のshutdown abortは`interrupted / application`へ収束する回帰contractを追加した。
- 同reviewのtargeted closureでは、cold model catalog取得のtimeout、接続断、Provider rejectionを一律の`capability_unavailable`へ縮退させ、terminal分類の根拠を失う問題を確認した。AdapterはProvider mutation送信前のcatalog失敗について、未送信のtransport codeまたはProvider rejection codeを型付き結果へ保持する。さらにconnection failure eventがmutation結果より先に到着した場合も、最初のterminal transport codeをAdapter ownerへ保持し、後続の未送信Thread / Turn mutationへ同じcodeを返す。runtimeはtimeoutと接続断を`interrupted / transport`、Provider rejectionを`failed / provider`、未対応model tupleを`failed / application`へ収束させる。
- 後続のtargeted re-reviewでは、Provider mutationのtransport応答を待つ間にAdapter固有のfatal eventが先着すると、close由来の`request_not_sent / write_rejected`が保存済みterminal causeを上書きする問題を確認した。Adapterのread / mutation settlement境界は、後着結果が外部副作用なしの`not_sent`である場合、generationが保持する最初のterminal causeへ収束する。cold model catalog待ちとProvider mutation待ちの両経路を、event / resultの順序を固定した回帰contractで確認した。
- Node.js 24.18.0でProvider failure family targeted 139 test、Adapter lifecycle / item / validation targeted 52 test、全854 testとSQLite schema validator、runtime guard、format、module boundary / lint、typecheck、buildを通した。runtime host、Session CLI、Run CLI、Run start / retry、compiled persistenceの各process smokeもGreenである。
- 既存ADR 005とADR 013を現行contractへ更新し、新しいADR、schema変更、accepted riskは追加していない。実Codex App Serverとのprocess E2EとUnix native executable経路は今回のdeterministic smokeの対象外である。

## 2026-07-29: CP3 Run start / retryのshutdown event drainとstartup failure分類

- shutdownとgeneration退役では、Adapter closeで新規受信を停止した後、close開始前に正規化済みのevent queueをEvent Serviceへdrainし、その完了後にgenerationを解放する。Providerが報告済みのterminal outcomeとfinal assistant Messageを、shutdown由来の`interrupted`へ置き換えない。
- Adapter closeは、受信済みevent queueとpending connection failureを保持する。close後もconsumerは`nextEvent()`でqueueをdrainでき、queueが空になった後にclosedを受け取る。
- Provider runtime startup failureを`configuration`、`capability`、`application`、`transport`、`process`へ分類する型付き境界を追加した。設定不備とcapability不一致はpre-dispatchの`failed / application`、process開始失敗は`interrupted / process`、shutdownとの競合は`interrupted / application`へ収束する。cleanup失敗はprocess ownerが未解決なため`process`を維持し、successor起動を拒否する。
- shutdown中に先行eventの永続化を待たせ、その間にfinal付きterminalをqueueへ追加する回帰contractを追加した。Adapter close後のterminal drain、設定未指定、非対応CLI version、process起動失敗、startup cleanup retryもそれぞれ直接検証した。修正前はterminal消失と決定的failureの`interrupted`分類を再現し、修正後は期待するterminalとfailure tupleへ収束した。
- 独立specialist reviewでは、Event Serviceの受理失敗時に取得済みeventと後続queueを破棄できる反例、native executableの形式検証がcurrent OSを区別しない反例、magicだけを持つ切断fileと有効entryの後ろに破損entryを持つfileをnative artifactとして受理する反例を確認した。runtimeは取得済みeventをEvent Serviceの受理完了まで保持し、同じeventから再開して残queueをdrainした後にだけgenerationを解放する。Event Serviceはqueued operationのrejectだけではAttemptとfrozen commandを破棄しない。Codex executableはWindowsのPE header、optional header、全section、LinuxのELF identity、header、全load segment、macOSのthin / fat Mach-O header、load command、section count、slice境界を検証し、wrong-OSまたは宣言構造の一部が切断されたartifactを設定失敗へ閉じる。
- Node.js 24.18.0でRuntime / Event Service / Adapter targeted 127 test、全865 testとSQLite schema validator、runtime guard、format、module boundary / lint、typecheck、build、diff checkを通した。runtime host、Session CLI、Run CLI、Run start / retry、compiled persistenceの各process smokeもGreenである。Run start / retry smokeでは、非対応CLI versionがProvider mutation前に`failed / application`、起動後のProvider process crashが`interrupted`となる区別を確認した。
- 既存ADR 005がpre-dispatch outcomeの判断を所有し、既存ADR 013とProvider designがconnection generationのowner境界を所有する。直接影響するProvider designを更新し、新しいADR、schema変更、accepted riskは追加していない。
