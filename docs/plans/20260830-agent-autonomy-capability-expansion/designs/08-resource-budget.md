# Resource budget

## 担当する能力

- root単位の同時実行、Turn、token、費用、retry、Session数、保存容量、deadline
- budgetのget、list、configureと内部reserve、settlement
- rootから子へのallocation
- provider usageとのreconciliation

## Budget model

### Slice 2 の採用方針（2026-09-07）

ユーザー指定により、root の初期 hard limit は同時実行 Turn 4、queued Turn 100、累積 Turn 1,000、自動 retry は失敗した実行ごとに3回かつ root 累計100回、Session 累積作成数100（rootを含む）、Work Item累積作成数500、delegation累積作成数500、管理対象ファイル容量1 GiB、root作成から30日とする。初期値の由来は既存の個別操作上限ではなく、このユーザー指定である。

同時実行、queue、保存容量は現在の占有量を管理する。作成数とTurn数は累積であり、削除や終了で枠を戻さない。同一要求のreplayは追加消費せず、自動retryの実行は累積Turnにも含める。既存Session単位の上限も維持する。

tokenと費用は今回の上限管理から除外し、取得可能な使用量を記録する。ゼロや無制限の架空の上限を保存しない。取得不能はunknownとして保持する。以降のtoken／費用reserveやhard capに関する記述より、この決定を優先する。

ユーザーは後からroot上限とdeadlineを設定変更できる。期限切れや予算不足で保留中のqueueは、設定変更後に再評価する。terminal executionを再実行したり、過去の消費量・結果をリセットしたりしない。Agentによる配分変更からroot上限や期限を増やすauthorityは得られない。

保存容量はroot配下のSessionFolderを対象とし、WorkspaceとMemoryを含めない。Providerや利用者がSessionFolderを直接編集する経路はWithMateの予約を経由しないため、厳密な事前hard capの保証外である。仲介する書き込みの予約と、実ファイルの観測・再精算を区別し、不明または超過時は新規dispatchを止める。

保存容量はRoot共有枠を使用し、子accountへの独立した容量配分は提供しない。`childAllocation.hardLimits.storageBytes` は0のみ受理する。実ファイル総量と子への予約枠を二重計上せず、Rootの容量上限を適用する。

delegation resource、Session move、root transfer、artifact transferは後続Sliceの接続対象とし、このSliceで実装済みとは扱わない。

Slice 1 は 2026-09-05 のユーザー承認に基づき、budget 未実装を runtime catalog へ明示し、既存操作別の上限だけを維持する。本 slice で ledger と admission を接続し、その validation gap を解消する。Slice 1 の grant migration に架空の allocation や無制限値は置かず、ここで実際の root policy と既存上限から budget を生成する。

budgetはAgent能力を固定Roleで封鎖せず、自律実行を有限資源へ収めるためのledgerである。soft limitとhard limitを区別する。

- soft limit: Agentへ通知し、縮退、統合、停止、追加grant要求を選ばせる。
- hard limit: admission serviceが新規effectを拒否する。

少なくとも次のdimensionを扱う。

- concurrent running Turn
- queued Turn
- total Turn／retry
- tokenまたはprovider usage unit
- monetary cost
- Session／Work Item／delegation count
- artifact／SessionFolder storage
- operation deadline

未知のprovider usageを0として扱わない。`unknown`、`estimated`、`reported`、`settled`を区別する。

## 公開操作候補

- `budget.get`
- `budget.list`
- `budget.configure`

reserve、consume、release、usage reconciliationはadmissionとsettlementの内部operationとし、callerが手動で正しい順序を組む必要をなくす。`budget.configure`はgrantの範囲内でsoft limit、child allocation、policyを設定する。root hard limitの増加はissuer authorityを要求する。

## Allocation と authority

root budgetはユーザーまたは上位grantから付与される。Agentは自分のavailable allocation内で子Session、delegation、consultationへ再配分できる。

```text
parent available >= child allocations + parent reservations
```

allocationはauthority grantと関連付け、grant revoke、expiry、Session move、root transfer時にownerを再評価する。budgetだけを移してaction grantを残す、またはその逆の状態を作らない。

## Admission と settlement

effect-bearing operationはadmission時にreserveし、完了時にactual usageをconsumeして余剰をreleaseする。

- queued Turnはqueue slotと推定usageをreserveする。
- running開始時にconcurrency dimensionをreserveする。
- terminal時にprovider usageをsettleする。
- cancel、timeout、crashではreservationをreconciliation対象にする。

遅延usage eventが到着した場合、既にreleaseしたreserveを別operationへ誤帰属させない。execution ID、provider generation、budget reservation IDで対応付ける。

## Deadline と retry

deadlineはwall-clock task budgetであり、個別request timeoutと分ける。deadline到達後もread、cancel、result collect、compensation、archiveを許可し、新規dispatchを止める。

retry budgetはoperation failureとWork Item retryを区別する。response lossのsame-request replayを新しいretry消費として数えない。

## Configure

Agentは委譲済みroot allocationの内部配分を自律調整できる。root hard limitそのものを増やすには、そのlimitを増やせるuserまたはissuer grantが必要である。soft limitはpolicy grantの範囲で変更できる。

## 必要な schema と service

- budget account、dimension、allocation、reservation、usage event
- atomic reserve／release／consume transaction
- admission service integration
- provider usage adapterとreconciliation worker
- root／Session／delegation／artifact projection
- budget alert Coordination Eventまたはdedicated notification
- retentionとledger compaction

## Migration

既存rootへ無制限を意味する暗黙値を保存しない。移行時のdefault hard limitは現在のruntime limitとユーザー設定から明示的に生成し、由来をbaseline eventへ記録する。費用情報を取得できないproviderは`unknown` usageとして扱う。

## Direct validation

- concurrent reserveがhard limitを超えない。
- exact limitで各dimensionの`>`と`>=` semanticsが一致する。
- child allocation合計とparent reservationがparent availableを超えない。
- response loss replayが二重reserveまたはretry count増加を起こさない。
- crash後にstale reservationを列挙し、actual operation stateからreconcileできる。
- late provider usageが正しいexecution／generationへ帰属する。
- grant revoke、Session move、root transferでallocation ownerが一致する。
- deadline後もcancel、collect、compensateを実行できる。
- ledger、tombstone、usage eventが無制限増加しない。

## Review lens

- per-item limitだけを検証してaggregate hard capを超える経路
- reserve／consume／releaseの到着順と二重settlement
- unknown usageを0または成功扱いするprojection
- budget adjustによるauthority escalation
- deadlineがrecovery operationまで禁止してrootを詰ませる経路
