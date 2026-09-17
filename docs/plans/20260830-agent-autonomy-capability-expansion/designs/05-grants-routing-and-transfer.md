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

### 2026-09-18 の方針更新（実装追従前）

自己宛のAgent-origin `turn.run / turn.enqueue`は禁止し、将来の自己実行は別権限のスケジュールで扱う。結果待ちの再開は依頼先Agentから返却先への明示Turnで行い、返送のauthorityも検証する。詳細とAuxiliaryの未決定事項は`docs/design/session-external-runtime.md`の「v6.4 方針更新: 自己宛Turnとスケジュールの分離」を正本とする。以下の任意Sessionへのroutingは、更新後には自己宛direct Turnを含まない。

実装時は自己宛baselineの見直し、明示grantでも迂回できない対象検証、CLI/MCP/HTTPとcatalog・testの追従、schedule作成と発火の認可分離を確認する。既存保存grant・queued executionの扱いは実装前に整理し、文書更新だけを理由に削除・取消しない。GUI送信、他Sessionからの受付、既存失敗通知は維持する。本更新でruntimeの挙動は変更していない。

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

root全体のcross-root transferは既存destination rootへの統合であり、`destinationParentSessionId: null`で指定する。source rootはIDを保ったままdestination root直属のexecutorへ変換する。source root直属の子はRoleとdepthを保ってdestination root直属へ付け替え、孫は既存の親を維持する。destinationがstandaloneの場合はoverall-coordinatorへ変換する。この構造変更ではbaseline grantを追加せず、既存grantの移管はdestinationの明示的なceiling内に限定する。child Sessionの移管には引き続きdestination parentが必要である。

sourceのterminal Root Work Itemは同じIDのdelegated Work Itemへ変換し、`originKind: "transferred_root"`で由来を保持する。creatorはdestination root、targetはsource Session、parentはnullとする。空の契約field、進捗、結果、predecessorと過去eventを維持し、通常のdelegated作成契約をこの例外へ拡張しない。destinationのRoot Work Itemを置換せず、結果の自動採用もしない。他のWork Itemのcreator、target、集約関係は維持してroot所属を移す。

source root budgetは同じaccount IDのsession allocationへ変換する。source直下のallocationはdestination root account直下へ移し、それより深いaccountの親は維持する。直属allocationのquotaは変換後source accountのlimitから差し引き、配分合計を増やさない。累積消費・履歴は保持し、共有storageのcommittedだけをdestination rootへ移送してsource accountのstorage limit・committedを0にする。destinationのhard limitを自動拡張せず、容量不足、未精算reservation、失効allocation、移管先deadlineを超えるallocationを拒否する。

削除済みSessionの口座は上記の利用可能allocationとは区別する。Sessionとbindingは移管・復活せず、口座はaccount ID、owner、累積消費、過去eventと既存parent accountを保った保存用データとしてdestination rootへ所属させる。移管時に未失効ならrevokeし、全dimensionのhard limitを0にする。既に失効している口座は失効時刻を維持する。旧allocationのexpiry・authority chain・deadlineだけを理由にroot移管を拒否せず、新規利用可能枠として再発行しない。保存用口座は予算一覧から失効状態で参照できる。

source直下の削除済み口座は変換後source accountの子として残し、未使用quotaは独立した割当として移さない。既存の失効口座の消費集計により、その消費済み量はsource側の利用可能枠から引き続き差し引く。生存口座の割当と合わせても元rootの総量を増やさない。削除済み口座を含め未精算reservationは引き続き移管を拒否する。削除済みownerの口座配下に生存ownerの口座が残る場合も、親の失効で生存口座を利用不能にしないよう移管前に拒否し、先にその口座関係を解消する。

移管に使用したsource root専用のtrusted transfer capabilityは、元rootでの操作完了として失効させ、destinationに再発行しない。その他のgrantはdestination ceilingを検証して移管する。移管で変更した全SessionのIDを既存operation manifestへ保存し、publication失敗後も同じ集合を再通知する。

actual root自身への操作は`self`と`root_owner`のscopeを持つ。root移管のDB commit後の再送は、既存operationに保存したprincipal・key・入力・移管先が一致する場合に限り、保存したdestination grantで再認可する。現在のruntime generation、grantの有効性とissuer chainは再検証するが、commit時のRole変更だけでは元admissionの再送を拒否しない。別要求をこの復旧scopeへ流用しない。

transfer manifestは次を列挙する。

- Sessionとdescendant
- Work Itemとaggregation relation
- running／queued execution
- grantとdelegated grant
- budget reserveとusage
- artifactとSessionFolder
- open Coordination Eventとpending interaction
- root resultとhistory

SessionFolderは実在するcanonical directoryを確認し、公開manifestには対応するSession IDだけを列挙する。移管処理に不要な絶対pathは含めない。既存の`session.get`によるSessionFolder pathの公開は変更しない。

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
