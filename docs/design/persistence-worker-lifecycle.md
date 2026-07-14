# Persistence Worker Lifecycle

## 目的

SQLite connection、request実行順序、transaction、checkpointをPersistence Workerへ集約し、Main processへversion付きrequest / response contractだけを公開する。

## Ownership

- SQLiteのprimary connectionはPersistence Workerが1本だけ保持する。
- Main process、Renderer、CLIは`node:sqlite`をimportせず、Worker clientを経由する。
- read、write、maintenanceは同じ有界FIFOへ入り、同時実行数を1とする。
- write transaction callbackは同期関数に限定する。型でPromise returnを拒否し、native async functionはtransaction開始前にも拒否する。型を迂回した通常関数がPromiseLikeを返した場合はrollback後にconnectionをcloseし、非同期継続から同じconnectionへ書き込めないようにする。
- checkpointだけはWorker内のmaintenance処理として短命connectionを使用できる。shutdown時はprimary connectionを閉じてからmaintenance connectionを開き、2本を同時に保持しない。
- runtime中の明示checkpointはprimary connectionと同じWorkerが所有する短命connectionで実行する。repository query / commandをそのconnectionから実行しない。
- maintenance connectionにも`foreign_keys=ON`、`secure_delete=FAST`、`busy_timeout=5000`、`wal_autocheckpoint=256`、`journal_size_limit=67108864`を設定する。

複数read connectionはsnapshot lifetime、shutdown、WAL管理を増やすため採用しない。S5の代表queryでsingle connectionが不足すると実測できた場合だけ再検討する。

## Protocol

全messageは`protocolVersion`とWorker世代ごとの`generationId`を持つ。通常request / response、cancel、shutdown / closedはcanonical lowercase UUIDの`requestId`で相関する。通常requestは世代内で単調増加する`requestSequence`も持つ。

MainからWorkerへのmessageは次の3種類とする。

- `request`: `operation`、`requestClass`、plain objectの`payload`
- `cancel`: 未実行requestの取消し
- `shutdown`: 新規受付停止とconnection closeの要求

WorkerからMainへのmessageは`ready`、`startupFailed`、`response`、`closed`とする。unknown version、generation、kind、field、非canonical IDはSQLiteへ渡さない。Workerは処理済み`requestSequence`のhigh-water markだけを保持し、同値以下のrequestをreplayとして拒否する。これにより世代内のexact replay拒否をrequest数に依存しないmemoryで実現する。

`requestClass`は`read`、`write`、`maintenance`のいずれかで、Worker側operation定義と一致しなければ実行しない。request IDはtransport相関用であり、repository commandのidempotency keyではない。

## Timeout、cancel、effect

failureは`effect`を必須とする。

| effect | 意味 |
| --- | --- |
| `none` | transactionまたは外部効果が発生していないことをtransport境界で確認できる |
| `unknown` | 実行結果をtransport境界から確認できず、commit済みの可能性がある |

`DatabaseSync`による実行中はWorker event loopがcancel messageを処理できない。このためcancel可能なのはqueue内の未実行requestとchunk request間だけである。

- queued requestのcancelは`effect=none`とする。
- read timeout後のlate responseはMainで破棄する。
- writeまたはmaintenanceのtimeout、Worker crash、forced shutdownは、実行開始済みの可能性がある場合`effect=unknown`とする。
- `effect=unknown`のwriteをtransportが自動再送しない。Repository commandのidempotency recordまたはread-backで呼出側が収束させる。
- crash後にold generationのresponseを受理せず、in-flight requestを新Workerへ移送しない。再起動はold Workerのexit後に新しいclient / generationを明示的に作成する。

## Shutdown

graceful shutdownは次の順序で行う。

1. Main clientとWorkerを`closing`へ遷移し、新規requestを拒否する。
2. Workerの未実行queueを`effect=none`で失敗させる。
3. 実行中requestの完了を待つ。
4. primary connectionを閉じる。
5. maintenance connectionで`wal_checkpoint(TRUNCATE)`を試行して閉じる。
6. checkpoint結果付き`closed`を返し、Workerを終了する。

checkpoint失敗はDB破損と同一視せず、`closed.checkpoint=failed`として通知する。shutdown timeoutは`closed`受信だけで解除せず、Worker exitまでを同じdeadlineで監視する。deadline超過ではWorkerをterminateし、正常shutdownとして扱わない。closing中のcrashはtimeoutを待たず`worker_crashed`へ収束させる。

## Payload chunk

`payload.read_chunk`はSQLite BLOB全体をhydrateせず、`offset`と`maxBytes`で範囲取得する。1 responseはtransfer bufferとJSON metadataの合計で最大256 KiBとし、専有`ArrayBuffer`をtransfer listでMainへ渡す。

1 chunkを1 request / responseとするため、consumerがresponse受領後に次requestを発行することがackとbackpressureになる。長寿命cursorをWorker内に保持せず、timeout、cancel、shutdown後にstream resourceを残さない。binaryのfull payloadは通常queryで返さず、明示export operationで同じchunk境界を使う。

## Errorとdiagnostic

公開errorは安全なcode、bounded message、retryable、effectだけを返す。DB path、SQL、payload、raw stackをresponseへ含めない。startup failureは自動restart loopを作らず、crash後のrequest replayも行わない。

## 検証境界

S4ではprotocol decode、FIFO、queue上限、transaction rollback、timeout / late response、crash、graceful / forced shutdown、request ID replay、256 KiB chunkを検証する。

次は後続Gateで検証する。

- S5: representative read queryとsingle connectionのlatency / queue behavior
- S6: repository commandのidempotencyと`effect=unknown`からの収束
- S7: request payload working-set上限、chunk連続取得のbackpressure、shutdown / commit境界のfault injection
- CP8: packaged Electron / asar配置からbuilt Workerを起動する経路
