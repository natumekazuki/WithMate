# Delegation transaction

## 目的

Delegationは、Session、Work Item、Turnの既存操作を一つの依頼として相関させる通常のdomain resourceである。Delegation固有のrowにはstable ID、actor Session、request、revision、itemごとのresource IDと状態、未完了stepの入力、直近mutation、recovery actionを保存する。

独自のhash、署名、event ledger、recovery verifier、汎用reuse registryは追加しない。Session、Work Item、aggregation retry、Turn、authority、budget、manifest、cancel、archiveの既存ownerとidempotency、transaction、revisionを再利用する。

## 作成

`delegation.create`は1〜20 itemを受け付ける。各itemは、既存または新規のtarget Session、既存・新規・root・aggregation replacementのWork Item、Turn入力を持つ。

- `dispatch: prepare`はSessionとWork Itemまで作成または解決し、Turn入力をrowへ保存する。Turnはenqueueしない。
- `dispatch: enqueue`は同じ順序で処理し、既存の`turn.enqueue` ownerへ保存済み入力を渡す。
- 新規Session、Work Item、Turnのidempotency keyはitemとstepごとに固定する。
- root Work Itemは作成済みのactor所有rootを再利用する。Delegationがroot successorを作成することはない。
- replacement Work Itemは既存の`work.aggregation.retry` ownerで作成する。既存Sessionと既存Work Itemの再利用は、新しいDelegationのinputで明示する。

最初にactor、Delegation操作のauthority、budget、requestを検証し、Delegation rowを作成してから副作用stepへ進む。Delegationの作成数は既存budgetの`delegations` dimensionへ同じDB transactionで記録する。canonical ownerは各stepでruntime bindingとcurrent grantを再検証する。

## 部分成功とstep状態

itemはSession、Work Item、Turnの順に処理する。各stepの開始前に、step名・固定input・開始時刻をrowのpendingとして保存し、ownerの応答直後にresource ID、state、effect certaintyを保存する。最初の失敗でbatchを止め、先行itemの結果、失敗itemのpending input、後続itemの未開始状態を返す。

DB commit後に応答が失われても、`delegation.get`または`delegation.list`でrowを読み直せる。uncertainな作成stepは同じinputと同じowner idempotency keyでのみ再送し、ownerが保存した応答を回収する。cleanupはcanonical stateを読み直してから再開する。既存retention boundaryを過ぎた不明stepをblind retryしない。起動時に自動dispatchや自動補償は行わない。

`dispatch: enqueue`の受付成功はproviderのterminal成功を意味しない。Turnは既存のadmission、queue、provider dispatch、settlementで処理され、Delegationはexecutionのterminal観測までactiveとして扱う。Delegationのcompletedはexecutionの終了を表し、成功とは区別する。providerの成功・失敗と詳細は返却されたexecution IDでturn.getから取得する。

## 公開操作

- `delegation.get` / `delegation.list`はactorが所有するrowだけを返す。
- `delegation.retry`はcurrent revisionと新しいmutation idempotency keyを要求し、保存済みpending inputを再開する。prepare後のTurn開始はretry enqueueで行う。
- `delegation.cancel`は新しいdispatchを止め、既存のTurn cancel ownerとstate guardを使う。
- `delegation.compensate`はTurn、Work Item、child Sessionの順に既存ownerへ接続する。未使用resourceは既存policyの範囲でcancelまたはarchiveする。
- 同じmutation keyで異なるpayloadを送った場合はidempotency conflict、古いrevisionはrevision conflictとして拒否する。

他consumerが採用したresource、開始済みWork Item、active provider effect、別Delegationから参照されたresourceは、既存guardにより無理に削除せず`recovery_required`へ遷移する。temporary artifactの新規作成や、既存manifest・grantの無断削除は行わない。

## 対応範囲

Delegationは既存操作のcompositionと相関保存を提供する。汎用のwork split/merge操作、grant baselineの拡張、起動時の自動再dispatch、provider effectの自動cleanup、累積budgetの返却はこの機能の責務にしない。未完了rowはget/listで確認し、canonical ownerが再送可能と判断できる場合だけretry、または明示的なcancel/compensateを行う。
