# Grants、routing、ownership transfer

## 担当する能力

- grantのcreate、list、get、revoke、expire
- same-root内の直接通信
- cross-root consultationと一時委譲
- Session、Work Item、root ownershipの移管
- Role matrixからgrant evaluationへの移行

## 公開操作候補

- `grant.create`
- `grant.list`
- `grant.get`
- `grant.revoke`

grant operationはshared authority設計のresourceを使う。子への委譲は`grant.create`へ`parentGrantId`を渡して表し、issuer自身のaction、scope、budget、expiryを超えられないようにする。期限延長は既存grantの不可逆な書き換えではなく、新revisionまたは新grantの発行として記録する。

consultationは一時grantとTurnまたは`delegation.create`の組み合わせ、Sessionとrootの移管は`session.move`、Work Itemの移管は`work.move`で表す。認可と移管transactionは共通serviceが所有し、同じ能力に別名の高水準operationを増やさない。

## Role の扱い

Roleは次だけを提供する。

- 作成時のdefault grant template
- UI上の責務表示
- Agent向けrouting hint
- managed Skillの推奨workflow

`standalone`、`overall-coordinator`、`task-coordinator`、`executor`というRole名だけで操作を拒否しない。認可はactive grant、resource scope、external side-effect class、budgetを評価する。

既存SessionのRole bindingは履歴として残す。migrationでRoleに対応するgrantを生成する場合、現行で許可されている範囲だけをbaseline grantとし、新しい広い能力を自動付与しない。新能力はユーザー設定または明示的なroot policyから付与する。

## Same-root routing

same-root内では、active communication grantを持つAgentが任意のSessionへTurnまたは一時委譲を送れるようにする。固定parent／sibling／grandchild matrixはdefault grant templateへ移す。

Turn requestはtarget Sessionを明示する。runtimeはactorとrootをbindingから解決し、targetへのactive grantを検証する。direct dispatchでもWork Itemまたはconsultation IDを関連付け、自由文だけの追跡不能な依頼にしない。

## Cross-root consultation

consultationはownershipを移さず、限定したread、message、artifact accessを一時付与する。

- requester rootとresponder root
- purposeとcompletion criteria
- visible resource set
- allowed actions
- budget
- expiry
- result／artifact return destination

consultation終了時はgrantをexpireさせる。resultとartifact provenanceは保持し、temporary accessだけを失効する。

## Ownership transfer

`session.move`または`work.move`は対象をdestination ownerへ移管する。root Sessionを移す場合はroot全体のtransferとなる。いずれもsourceとdestination双方のauthorityを要求する。

transfer manifestは次を列挙する。

- Sessionとdescendant
- Work Itemとaggregation relation
- running／queued execution
- grantとdelegated grant
- budget reserveとusage
- artifactとSessionFolder
- open Coordination Eventとpending interaction
- root resultとhistory

transfer中は対象rootを`draining`にして新規mutationを制限する。ただしread、cancel、transfer recoveryは許可する。commit後publication failureはtransfer IDとeffect certaintyを返し、両rootを二重ownerにしない。

## Revoke と実行中operation

revokeは新規admissionを直ちに止める。既にcommit中のoperationは使用したgrant revisionをeventへ記録し、一貫した結果へsettleする。running Turnはgrant policyに応じて次を選ぶ。

- allow-to-settle
- cancel
- drain-to-handoff

遅延provider eventがrevoke後の新resourceへ作用しないよう、executionとgrant generationを結び付ける。

## 必要な schema と service

- grant store、event、expiry index
- communication／consultation resource
- transfer manifestとdraining lifecycle
- current route projection
- Turn、Work Item、artifact serviceのgrant evaluator統合
- 既存全operationのgrant action／resource scope／effect class mapping
- baseline active grant migrationとRole authority cutover
- runtime catalogのgrant capability／limit projection

## Direct validation

- child grantがissuerのaction、scope、budget、expiryを超えない。
- same-root direct dispatchがparent matrixなしでも追跡可能なresourceを持つ。
- cross-root consultationが指定resource以外を読めない。
- consultation expiry後に新規read／writeできず、既存result provenanceは残る。
- adopt／root transferのfailure injectionで二重ownerまたはorphanを作らない。
- revokeとrunning／queued operationの各policyを検証する。
- stale runtime generationとexpired grantでretryできない。
- migration baseline grantが現行authorityを超えない。
- 既存全operationがgrant mappingを持ち、未分類operationをRole fallbackで許可しない。

## Review lens

- grant union、wildcard、scope inheritanceによるauthority escalation
- trusted GUI principalとAgent principalの混同
- revoke、expiry、retry、response lossの競合
- transfer manifestから漏れたresource owner
- Role判定がadapterやmanaged Skillへ残り二重authorityになる経路
