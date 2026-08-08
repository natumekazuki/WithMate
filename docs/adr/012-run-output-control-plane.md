# ADR 012: Run outputのbounded readとexplicit export

- Status: Accepted
- Date: 2026-07-19
- Amended by: ADR 013のruntime host ownership

## Context

CP2では、永続化済みRun outputの件数、一覧、payloadをCLIから参照するcontrol planeが必要である。Run outputには最大16 MiBのpayloadとbinaryが含まれるため、通常のSession hydrateやRun statusへ本文を追加すると、Worker response budgetを越え、本文を複数のprocessで複製する。Repositoryにはbounded pageとpayload chunkがあるが、non-stored itemのavailabilityをpage scanなしで判定するpoint readと、filesystemへ公開するApplication境界はなかった。

ExportはRepository readに加えてfilesystem副作用を持つ。CLIがchunk loopとfile writeを直接所有すると、authorization、Run scope、payload availability、integrity、publication timingがApplication responseから分離する。一方、current OS userとして動くlocal CLIを対象とする機能に、destination directoryを同時に置換できる敵対processとの完全な競合防御まで要求すると、platform固有のnative handle操作が必要になり、現時点の配布と保守の負担に見合わない。

Session CLIのJSON envelope、exit code、lifecycleはADR 006、Run observationのscope解決とshutdownはADR 011で決定済みである。Run outputもこの境界を維持し、field、limit、payload stateの組はtype、projection、testを正本とする。

## Decision

Run outputのpublic ownerを`ApplicationRunOutputOperations`とし、category counts、bounded item page、preview、chunk、exportを提供する。各操作はApplication boundaryでrequestを検証してoperation固有のtargetを認可し、Repository boundaryでWorkspace、Session、Run、output itemの組を再検証する。CLIはApplication operationだけを呼び、Repository clientやfilesystem streamを所有しない。

Countsとitem pageは`run_output_items`だけを読み、payload tableをjoinしない。Payloadを必要とする操作は、scope付きpoint readでitemとavailabilityを確認し、storedの場合だけmetadataとchunkを読む。TextとJSONのpreviewは先頭64 KiB、chunkは1回256 KiBを上限とし、JSON source bytesをparseまたは再整形しない。Binary previewはmetadataだけを返し、binary chunkは拒否する。CLIはApplicationの`ArrayBuffer` chunkを1回だけbase64 envelopeへ変換する。

Export requestは、CLI userが明示したabsolute pathを表す`explicit_absolute_path` grantを受け取る。Applicationはvalidation、authorization、scope、availability、metadataの確定後にfilesystem副作用を開始する。Filesystem side-effect boundaryは、同じdirectoryにexclusiveなtemporary fileを作成し、payloadをoffset 0から逐次読み、各writeの完了を待つ。読んだ実byte数でoffsetを進めながらSHA-256とlengthを計算し、metadataと一致した場合だけflush後にpublishする。

Destination directoryの解決とidentity検証を含むfilesystem処理は、終了可能なhelper processへ集約する。Hard timeout、SIGINT、またはclient connection lossでは、runtime hostへcancelを伝播する。runtime hostはhelperへ中断を通知し、猶予時間内に終了しなければhelperを強制終了する。これにより、filesystem I/Oが応答しない場合も、client requestのlifecycleを有限時間に保つ。

runtime hostへのownership移行はADR 013を正本とし、このbounded cancelをRun cancelへ流用しない。

Publishはtemporary fileからdestinationへのhard linkを作るexclusive operationとし、既存file、symlink、junction、同時に成功した別exportを上書きしない。Temporary fileとdestinationのfilesystem identity、parent directoryのpathとidentityをpublish前後に検証する。検証可能な不一致ではpublishせず、publishの成否を確定できないtimeout、cancel、helper response lossでは結果を`unknown`として返す。

Public publication outcomeは次の3つに分ける。

- `published`: destinationの公開を確認済み。通常successと、公開後のtemporary cleanupだけが残るpartial successに使用する。
- `not_published`: destinationが公開されていないことを確認済み。temporary cleanupの完了または未完了を併記する。
- `unknown`: publishの成否を確認できない。callerはdestinationを確認してから再試行する。

Raw destination path、temporary path、OS error、stored payload IDはpublic responseへ含めない。既存destinationを見つけたretryは`destination_exists`になり、前回の成功を推測しない。

Supported threat modelは、同じcurrent OS userで動くlocal clientとruntime hostによる通常利用である。Destination directoryをexport中に任意の時点で置換できる敵対processまたはprincipalは対象外とする。Identity検証は通常の差し替えと曖昧なpublicationの検出に使うが、敵対的なpathname raceを完全に防ぐ保証にはしない。

## Alternatives

- CLIにchunk loopとfilesystem writeを持たせる: authorizationとfailure timingがApplication operationから分離し、GUIなど別consumerが同じ契約を再実装するため採用しない。
- Payloadを1 responseへ全量読み込み、最後にfileへ書く: Worker、Main、CLIで最大payloadを複製し、binaryを通常responseへ流すため採用しない。
- Temporary fileをdestinationへrenameする: platformによって既存destinationを置換でき、no-clobberを一貫して保証できないため採用しない。
- Destinationを事前確認してから通常writeする: existence checkとopenの間に競合があり、同時exportで上書きできるため採用しない。
- Native addonでdirectory handle相対のopenとrenameを実装する: 敵対的なdirectory置換まで防げる可能性はあるが、現在のlocal CLI threat modelに対して配布、platform差、保守の負担が大きいため採用しない。
- Crash後のtemporary fileを起動時に自動削除する: 生存processのexportとの所有権判定とsweep lifecycleが必要になるため、今回のcontrol planeには含めない。

## Consequences

- Run status、events、follow、Session hydrateはpayload本文を暗黙に読まず、large outputとbinaryをbounded readから分離できる。
- Callerはavailability、format、actual bytes、EOF、publication outcomeを使って、payload stateとfailure timingを推測せずに扱える。
- Exportはpayload sizeに比例するheap bufferを作らず、metadata不一致やwrite失敗ではdestinationを公開しない。
- Export helperが中断へ応答しない場合も強制終了されるため、clientのhard timeout、SIGINT、connection lossはfilesystem I/Oを含むexport lifecycle全体をboundedにできる。
- Concurrent exportは1件だけがdestinationをpublishし、後続は既存destinationを変更しない。
- Publish成否を確認できない場合は`unknown`になり、自動retryの前にdestination確認が必要になる。
- 敵対processによるdestination directoryのpathname raceはsupported threat model外に残る。sharedまたはuntrusted directoryへのexportをsupported scopeへ追加する場合は、native handle相対operationを再検討する。
- Process crashではsame-directory temporary fileが残る可能性がある。現時点では停止後に識別可能なtemporary fileを確認して手動回収し、自動sweepは別のlifecycle判断とする。
- Run `start`、`retry`、active `cancel`、supplemental input、Provider runtime ownershipのpublic名とprocess modelはADR 013で確定したが、production実装はCP3の後続sliceとする。

## Related decisions

- `docs/adr/003-application-service-operation-envelope.md`
- `docs/adr/006-cli-session-control-plane.md`
- `docs/adr/011-run-observation-control-plane.md`
- `docs/adr/013-runtime-host-and-run-mutation-control-plane.md`
- `docs/design/multi-agent-persistence.md`

## Contract anchors

- Public Application types: `src/shared/application-run-output-model.ts`、`src/shared/application-service-model.ts`
- Application behavior: `test/application-run-output-service.test.ts`
- Filesystem publication: `test/run-output-exporter.test.ts`
- CLI type and projection: `src/cli/contract.ts`、`test/cli-run-output-contract.test.ts`
- Process integration: `scripts/smoke-cli-run.mjs`
