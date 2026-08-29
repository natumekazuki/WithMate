# Work Item lifecycle

## 担当する能力

- goal、scope、completion criteria、authority descriptionの改訂
- running admission時のactual source identity確定
- target reassignとparent reparent
- split、merge、clone
- terminal Work Itemのreopenまたはsuccessor
- archiveと物理delete

## 公開操作候補

| Capability | Operation candidate | 契約 |
| --- | --- | --- |
| 契約改訂 | `work.revise` | mutable contract fieldsをrevisioned eventとして保存 |
| 担当変更 | `work.reassign` | targetとexecution planを原子的に移管 |
| 親変更 | `work.move` | aggregation ownerとroot relationを再構成 |
| 複製 | `work.clone` | new stable identityで契約を複製 |
| 再開 | `work.reopen` | terminal resultを保持しactive successor revisionを作成 |
| archive | `work.archive` | current active viewから除外し履歴保持 |
| restore | `work.restore` | archived Work Itemを新lifecycle revisionで復帰 |
| 削除 | `work.delete` | retentionとrelation closure後に物理削除 |
| 履歴 | `work.history.list` | contract、assignment、lifecycle、result eventを取得 |

Root WorkItemとdelegated WorkItemは同じevent／revision基盤を使う。actor authorityと変更可能fieldはkind、current state、active grantで判定する。

## Revise と actual start source

`work.revise` はownerまたは明示的なmanage grantを持つactorが実行する。targetは`change.request`相当のCoordination Eventまたはgrantで改訂を提案できるが、他Session所有の契約を暗黙に上書きしない。

Work Itemは予定時点の`plannedSourceIdentity`を次のtupleで扱う。

- workspace identity
- repository identity
- branch
- base commit
- head commit

作成時に確定できないfieldは`null`を許容する。実際の開始地点はcaller入力で確定せず、queuedからrunningへadmitする時点でcanonical Workspaceから`actualStartSourceIdentity`を解決する。execution associationへWork Item revisionとactual snapshotを同じtransactionで保存する。事前確認が必要な場合だけread-onlyな`work.source.resolve`を提供する。

plannedとactualのsource fieldを個別に混ぜず、それぞれtupleとして保存する。Git外Workspace、detached HEAD、unborn branchもstrict unionで表す。queued executionを別Work Item revisionへ付け替えた場合はadmission時にcurrent associationを再検証する。

## Reassign と reparent

reassignはtarget変更だけでなく、次を一つのtransfer planとして扱う。

- old targetのrunning／queued execution
- active interaction
- result draftとartifact
- target向けgrantとbudget reservation
- Coordination Eventの宛先
- source identityの再確認要否

old targetの実行を継続したままnew targetへ同じactive revisionを割り当てない。cancel、handoff、parallel successorのいずれかを明示する。

reparentはaggregation decision、root、creator、target、descendantとの関係を再検証する。既にdecide済みのchildを別parentへ直接移動せず、旧decisionのsupersedeと新parentへのadoption eventを同じtransactionで保存する。

## Split、merge、clone

splitは`delegation.create`のbatch inputで複数childを作り、source Work Itemへ`split` eventとchild IDsを保存する。Work Item lifecycle側に重複する`work.split` operationを作らない。sourceをterminalにするかactive coordinatorとして残すかはdelegation inputで指定する。

mergeは複数childのaggregation decisionと親`work.result`によって表す。新しいsuccessorが必要な場合は`work.clone`または`delegation.create`で作成し、sourceごとのresult、decision、unverified item、採用、除外、未解決をparent result provenanceへ記録する。重複する`work.merge` operationは作らない。

cloneは契約templateの複製であり、result、decision、execution、idempotency、historyを複製しない。source linkだけをeventへ残す。

## Reopen と successor

terminal rowをactiveへ直接書き換えない。`work.reopen`は次のいずれかを作る。

- 同じWork Item identity上のactive lifecycle revision
- 新しいsuccessor Work Item

実装時にquery、foreign key、aggregation semanticsを比較して一つをADRで選ぶ。いずれの場合も旧terminal resultはimmutable eventとして残り、新active revisionが旧resultをsupersedeした理由を持つ。

parentが旧terminal resultを既にacceptedとしてfinalize済みなら、reopen前にparent result correctionまたは新successor branchが必要である。子だけをactiveに戻してparentをterminalのまま残さない。

## Archive と delete

archiveは履歴とrelationを保持し、default listから除外する。deleteは次を満たす場合だけ許可する。

- active execution、open interaction、active descendantがない
- resultとdecisionが必要な親またはsuccessorへ移管済み
- audit retention期間とdelete grantを満たす
- idempotency replayとevent tombstoneに必要なidentityを保持する

Agentが作成直後に不要と判断した未着手Work Itemは、自律的にarchiveまたはdeleteできる。履歴が外部consumerに採用された後はarchiveを既定にする。

## 必要な schema と service

- Work Item lifecycle eventとcontract revision
- source identity revisionとexecution association revision
- transfer、split、merge、delete manifest
- successor／predecessor relation
- root／delegated共通mutation service
- aggregationとresult correction serviceへの連携
- list／getのcurrent、history、archived projection

## Migration

進行中Root WorkItem実装のcontract revisionをbaseに、既存current rowを`migration_baseline` eventへ写す。既存result、aggregation decision、replacement relation、execution associationはそのまま保持する。既存terminal rowをreopen可能として自動変更せず、操作を受けた時だけ新lifecycle revisionを作る。

## Direct validation

- pending、in-progress、waiting、terminalごとのrevise可能fieldを直接検証する。
- source refreshがworkspace／repository／branch／base／headをtupleで保存する。
- execution開始後のsource revisionとexecution associationが一致する。
- reassignの各failure pointで二重targetまたは無targetを作らない。
- reparentがcycle、root不一致、decision orphanを作らない。
- split、mergeのsource／successor relationとresult provenanceをevent replayできる。
- cloneがresult、history、idempotencyを複製しない。
- reopenが旧terminal resultとparent finalizationを破壊しない。
- archive／delete後のretry、list visibility、tombstoneを検証する。

## Review lens

- mutable contractとcanonical authorityの混同
- source identity refreshと実際のexecution開始地点のずれ
- transfer中のrunning execution、artifact、budgetの取りこぼし
- reopenがterminal rowやaccepted parent resultを直接上書きしていないか
- split／mergeのprovenanceとaggregation scope
