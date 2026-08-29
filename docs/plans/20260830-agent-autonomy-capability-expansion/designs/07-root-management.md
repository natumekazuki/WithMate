# Root management

## 担当する能力

- root detail、list、Session tree、Work tree、status
- root stop、archiveとaggregate result参照
- root全体のdrain、cleanup、handoff

## Root resource

root identityはroot Session IDとする。別のroot IDは採番せず、root lifecycleとcurrent statusを明示するapplication projectionを追加する。Root WorkItem、grant、budget、transferはroot Session IDを共通の集約keyとして参照する。この決定はauthorityとmigrationのADRへ記録する。

Root current projectionは少なくとも次を返す。

- root identityとroot Session
- Root WorkItemとcurrent purpose revision
- lifecycle state
- Session／Work Item／execution／artifact counts
- active grantとbudget summary
- blocker、pending user decision、recovery-required operation
- aggregate result revision

## 公開操作候補

- `root.list`
- `root.get`
- `root.status`
- `root.stop`
- `root.archive`

root作成は`session.create`のroot placement、Session treeはSession query、Work treeはWork Item query、ownership transferは`session.move`、result確定はRoot WorkItemの`work.result`で表す。root APIは集約queryとroot全体の停止、archiveに限定し、各subsystemと二重のmutation ownerを持たない。

## Query

root queryは各subsystemのfull payloadを無制限にhydrateしない。status summaryとresource cursorを分け、detailは各resource APIで取得する。

Agentはactive grantの範囲で複数rootを一覧できる。trusted GUIだけが全rootを見られる現在の境界を固定せず、ユーザーが付与したglobal／project grantをAgent queryにも適用する。

## Stop と drain

`root.stop`は新規admissionを止め、strict unionで指定した`cancel`または`drain` policyに従ってqueued／running Turn、delegation、Work Itemをcancel、settle、handoffする。物理削除は行わない。

drainは新規mutationを止め、既存operationをsettle、collect、transfer可能な状態へ進める。root transfer、archive、application shutdown前の共通lifecycleとして使う。

```text
active -> draining -> drained -> archived
   |          |          |
   +-------> canceling -> canceled
```

recovery、read、cancel、transfer自身はdraining中も許可する。drainingをRoleやUI表示だけで判定せず、admission serviceがroot lifecycle revisionを検証する。

## Root result

Root WorkItem resultをroot resultのcanonical sourceとする。`root.get`と`root.status`は新しい独立result rowを作らず、Root WorkItemとdescendant aggregationのfinalized revisionを投影する。

訂正やreopenでRoot WorkItem resultがstaleになった場合、root resultもstaleとなる。古いresultは履歴として参照できるがcurrent finalとして配布しない。

## Archive と transfer

archiveはroot全体をdefault active viewから外し、grantを新規mutation不可へ縮退し、budget reserveを解放する。read、export、reuse、retention cleanupは許可する。

root Sessionへの`session.move`はgrant設計のmanifestとdraining lifecycleを使う。source owner、destination owner、root Session、Work Item、artifact、budget、Coordination、pending operationを一括で移す。transfer完了後もlineageと旧owner eventを保持する。

## Cleanup

root cleanupはorphan resourceを自動探索できるが、発見しただけで物理削除しない。各resourceのowner、reference、retentionを解決し、次へ分類する。

- resume可能
- transfer可能
- archive可能
- discard可能
- delete可能
- manual recovery required

Agentはgrantの範囲で分類結果から自律選択できる。

## 必要な schema と service

- root lifecycle eventとcurrent projection
- root summary queryとresource cursors
- root admission state
- drain／cancel orchestrator
- Root WorkItem result projection
- archive／transfer／cleanup manifest
- grant、budget、delegation、artifact service integration

## Migration

既存root Sessionごとにroot lifecycle baselineを作る。Root WorkItem実装後はそのidentityとstateを参照する。既存running／queued execution、Coordination Event、child Sessionをroot projectionへ集約するが、状態を変更しない。

## Direct validation

- summary queryがfull payloadをhydrateせずresponse上限とcursor scopeを守る。
- active grantのないrootをAgent list／getできない。
- drain開始後に通常mutationをadmitせず、recovery／cancel／transferは可能である。
- cancel／drainのfailure injectionでresource ownerとroot stateが不整合にならない。
- Root WorkItem訂正／reopenがroot result stalenessへ反映される。
- archiveがnew mutationを止め、read／export／reuseを維持する。
- transfer後に二重owner、orphan grant、budget reserve、artifactを残さない。
- cleanup分類がactiveまたは参照中resourceをdelete可能にしない。

## Review lens

- root summaryと各resource canonical sourceのずれ
- drain／cancel中の遅延executionとnew admission
- trusted GUI global queryとAgent grant queryの認可差
- Root WorkItem resultとroot resultの二重正本
- cleanupがhard delete policyを迂回する経路
