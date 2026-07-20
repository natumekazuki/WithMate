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

| ID | 発生条件と影響 | 検知と復旧 | 再判断条件 |
| --- | --- | --- | --- |
| CP2-CLI-R1 | create時の`fs.stat`はOS I/O自体をcancelできないため、応答しないnetwork mountではoperation timeout後もprocessが残る可能性がある。 | 呼び出し元のprocess timeoutで検知し、対象processを終了できる。Session commit前でありデータ影響はない。 | network Workspaceをsupported scopeへ含める場合に、別processでの検証またはcancel可能な境界を検討する。 |
| CP2-CLI-R2 | base branchで作成されたpre-release schema v1 DBは、同じversion内のschema hash変更によりstartup時に拒否される可能性がある。 | startup failureとして検知できる。互換契約のない開発DBは再作成できる。 | schema v1の外部利用開始前、または既存DB保持がaccepted contractになった時点でmigration方針を決める。 |
| CP2-CLI-R3 | Windowsの通常path、extended-length path、UNC aliasはfile identityまで同一化しないため、同じdirectoryを別Workspaceとして扱う可能性がある。 | list結果のWorkspace path差異で検知でき、SessionはIDで引き続き操作できる。 | file pickerや外部callerが複数のpath表現を渡す段階で、realpathまたはfile identityによる同一化を検討する。 |

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

| ID | 発生条件と影響 | 検知と復旧 | 再判断条件 |
| --- | --- | --- | --- |
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

| ID | 発生条件と影響 | 検知と復旧 | 再判断条件 |
| --- | --- | --- | --- |
| CP2-RUN-OUTPUT-R1 | Destination directoryを同じcurrent OS userの敵対processがexport中に置換した場合、pathname raceを完全には防げない。通常のidentity不一致は検知するが、敵対processに対するsecurity boundaryにはしない。 | Identity不一致またはpublication不明として検知できる場合は`unknown`を返し、destinationを確認してから再試行する。 | Sharedまたはuntrusted directory、別principal、adversarial local processをsupported scopeへ含める場合は、native directory handle相対operationを検討する。 |
| CP2-RUN-OUTPUT-R2 | Process crashまたは強制終了では、publish前またはpublish後cleanup前のsame-directory temporary fileが残る可能性がある。Destinationは既存fileを上書きしないが、temporary fileがdiskを消費する。 | 停止後に`.withmate-output-*.tmp`を確認し、export processが動いていないことを確認して削除する。Destinationの有無と内容を確認してから再試行する。 | Long-lived runtime、automatic retry、定期maintenanceを導入する場合は、temporary file ownershipとsafe sweepを設計する。 |

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

| ID | 発生条件と影響 | 検知と復旧 | 再判断条件 |
| --- | --- | --- | --- |
| CP3-RUNTIME-R1 | CAS-010の履歴反映を確認するためpersistent Threadを作成する。repository外workspaceの削除後も、syntheticなThreadが設定済みCodex profileへ残る可能性がある。既存Thread、repository data、secretは変更せず、Thread IDと本文を証跡へ出力しない。 | CodexのThread一覧で検知し、不要なら対象Threadをarchiveできる。 | 隔離したProvider stateで認証を安全に利用できる手段、または作成Threadを確実に削除できるstable APIが利用可能になった時点でprobeを更新する。 |
