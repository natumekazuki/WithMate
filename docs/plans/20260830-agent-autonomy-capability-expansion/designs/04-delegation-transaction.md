# Delegation transaction

## 担当する能力

- child Session、Work Item、初回Turnの一括作成
- delegation retry、compensate、cancel
- response loss、process crash、provider failureからの再開
- 部分成功resourceのreuse、resume、rollback

## Public resource

Delegationを一時的なhelperではなく、複数resource mutationの相関と回復を所有するapplication resourceとして扱う。stable delegation IDとstateを持たせる。

```text
preparing -> prepared -> dispatching -> active -> settling -> completed
                          |             |          |
                          +-----------> compensating -> compensated
                                        |
                                        +---------> recovery_required
```

単一database transactionでSession、Work Item、Turn executionを全てcommitできる場合でも、provider起動やWorkspace副作用はtransaction外に残る。したがって、operation recordとrecovery stateは必要である。

## 公開操作候補

- `delegation.create`
- `delegation.get`
- `delegation.list`
- `delegation.retry`
- `delegation.compensate`
- `delegation.cancel`

create inputは次のstrict unionとする。

- existing SessionへWork ItemとTurnを作る
- new child Session、Work Item、Turnを作る
- new root Session、Root WorkItem successor、Turnを作る
- prepareだけ行い、dispatchを後で開始する

既存の`session.create`、`work.create`、`turn.enqueue`は単体操作として維持する。delegation serviceはこれらのstorage ownerを迂回せず、共有transaction helperまたは明示的なsaga stepとして呼ぶ。

## Create semantics

createは先にoperation recordとrequest fingerprintを確定し、各stepのresource IDをserver側で予約する。

1. actor、grant、budget、target planを検証する。
2. delegation recordとreserved IDsを保存する。
3. Sessionが必要ならcanonical create ownerで作成する。
4. Work Itemを作成し、Sessionと関連付ける。
5. Turn optionsをcurrent catalogから解決し、executionをenqueueする。
6. stateを`active`へ更新し、resource manifestを返す。

step 3から5の間で失敗した場合、callerへ単純な失敗だけを返さず、committed resource、pending step、選択可能なrecovery actionを返す。

## Recovery policy

Agentは次から自律的に選べる。

- resume: 同じresourceを使って未完了stepを続行する。
- reuse: SessionまたはWork Itemを別delegationへ明示的に引き継ぐ。
- retry: retryable stepだけを同じdelegation IDで再実行する。
- compensate: このdelegationが作成し、他consumerが採用していないresourceを逆順に戻す。
- cancel: 新しいdispatchを止め、active resourceをcancelまたはhandoffする。

自動compensationを唯一のpolicyにしない。作成済みSessionで有用な調査が始まっている場合、削除よりresumeまたはreuseが適切なためである。

## Compensation

compensationはresource取得の逆順を基本とする。

1. queued／running Turnをcancelし、terminal effectを確認する。
2. Work Itemをcancel、archive、またはdeleteする。
3. child Sessionをdiscard、archive、またはreuse待ちにする。
4. budget reservationとtemporary grantをreleaseまたはrevokeする。
5. temporary artifactをretention policyに従って処理する。

各stepは独立したidempotency recordを持ち、process crash後に続きから再開できる。compensation中に外部consumerがresourceを採用した場合は`recovery_required`へ遷移し、無理に削除しない。

## Retry

retryは同じdelegationの未確定stepを再試行する。別target、別goal、別authorityへ変更する場合はdelegation revisionまたはnew delegationとする。同じidempotency keyでrequest内容を変えない。

Work Item resultに対する再実行はaggregation retryと連携し、replacement Work Item、Session reuse／new create、Turn dispatchを一つのdelegation retry manifestへまとめる。

## 必要な schema と service

- delegation operation table、state event、resource manifest
- reserved identityとstep-level idempotency
- Session、Work Item、Turn、grant、budgetのshared transaction／saga adapter
- recovery action projection
- compensation executorとstartup reconciliation
- runtime catalogとmanaged Skillのdelegation workflow

## Direct validation

- createの各step failureでcommitted resourceとnext actionが正確に返る。
- commit後response lossから同じkeyで同じdelegation IDへ収束する。
- process crash後にprepared、dispatching、compensatingを列挙して再開できる。
- compensationがresource取得の逆順で進み、他consumer採用後に削除しない。
- resume／reuse／retry／compensateを別payloadで同じkeyへ混在させない。
- duplicate Session、Work Item、Turn executionを作らない。
- budget reserveとrelease、grant issueとrevokeがresource manifestと一致する。
- replacement Work Item作成後にTurnが未dispatchのまま隠れない。

## Review lens

- database transactionと外部side effectの境界
- effect certaintyを`none`へ誤分類するfailure path
- compensation中の遅延Turn／provider event
- resource adoptionとcleanupの競合
- startup reconciliationが別generationのoperationを誤回収しないか
