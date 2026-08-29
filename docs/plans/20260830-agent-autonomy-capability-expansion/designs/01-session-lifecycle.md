# Session lifecycle

## 担当する能力

- Agent による root Session と child Session の作成
- Character、Provider、Workspace、Role template の明示選択
- Session 設定の revisioned update
- moveによるreparent／adopt、restoreによるreuse、clone
- archive、delegation compensation、物理delete

## 公開操作候補

| Capability | Operation candidate | 主な入力 |
| --- | --- | --- |
| root／child作成 | `session.create` 拡張 | placement、Role template、Character、Provider、Workspace、initial grant、budget |
| 設定変更 | `session.configure` | strict configuration union、expected revision |
| 親変更／引受 | `session.move` | destination parent／root、grant transfer policy |
| 複製 | `session.clone` | source、copied fields、new placement |
| 再利用 | `session.restore` | archived Session、new purpose、new binding revision |
| archive | `session.archive` | reason、descendant policy |
| 物理削除 | `session.delete` | expected revision、deletion manifest |

`session.configure` は title だけでなく、実行設定、Workspace、Character、Provider、Role templateを扱う。generic patchではなくstrict discriminated unionを使い、依存tupleの一部だけを変更しない。Provider、model、reasoning、catalog revision、thread continuity、Character runtime identity、Workspace grantsは組として解決する。

## Session identity と変更可能性

Session ID、作成時刻、過去eventは不変とする。root、parent、Role、Character、Provider、Workspaceは変更できるが、直接上書きせずbinding revisionを追加する。

実行中Turnは開始時のbinding revisionを保持する。Session update後に遅れて完了したTurnを新bindingへ帰属させない。新規Turnは最新active bindingだけを利用する。

Character変更は会話履歴の所有者を偽装しない。過去messageとaffect eventは当時のCharacter identityを保持し、新しいCharacterは変更後のTurnから適用する。Character-owned MemoryのownerをSession moveやCharacter changeで自動移管しない。

## Root 作成

Agentによるroot作成は、現在のrootから独立した作業領域を作る`session.create`のroot placementである。作成元Agentのgrantにroot placementを許可する`session.create` actionが必要で、次を同じtransactionまたは一つのrecovery可能なapplication operationで確定する。

- root Session rowとbinding revision
- Root WorkItem
- root grantとbudget allocation
- SessionFolderまたは選択Workspace reference
- idempotency result

新rootのgrantとbudgetは作成元の委譲可能範囲を超えない。作成元rootとのlineageはaudit用に保存するが、暗黙のread／write authorityを与えない。

## Move、adopt、reuse

`session.move` は同じroot内のparent変更と、rootまたはowner境界を越える移管をstrict unionで扱う。cross-root variantだけがsourceとdestination双方のgrant、transfer manifest、drainingを要求する。

moveは次を原子的に再評価する。

- cycleが生じないこと
- running Turnとqueued Turnの扱い
- active Work Itemのtarget／creator relation
- descendant Sessionのroot projection
- grant、budget、artifact visibility
- Coordination Eventの宛先とpending response

cross-root moveはsource rootとdestination root双方のgrantを必要とし、transfer manifestへSession、descendant、Work Item、artifact、budget reservation、open coordinationを列挙する。対象を暗黙に落とさない。適用できないresourceが一つでもあればcommit前に拒否するか、明示されたpartial transfer planへ分ける。

restoreはarchive済みSessionへ新しいpurpose revision、Root WorkItem successor、active binding、budgetを追加する。既存active Sessionのreuseはdelegation targetの選択で表し、別operationを追加しない。過去履歴を新規Sessionの履歴として書き換えない。物理的なprovider threadを継続するかresetするかはProvider tupleの一部として明示する。

## Archive、discard、delete

- archive: current操作対象から外す可逆な状態。履歴、artifact、grant tombstoneを保持する。
- delete: retention契約に従う物理削除。実行前にdeletion manifestを返し、同じmanifest revisionをmutationへ要求する。

Agentは自分が作成した未使用childを、delegation compensationからユーザー確認なしでdeleteまたはarchiveできる。running Turn、未回収result、第三者所有artifact、未移管grantがある場合は、先にcancel、collect、transfer、archiveを行う。単にRoleがexecutorであることをdelete拒否理由にしない。

内部に既存のSession delete serviceがあるため、Agent APIは新しい物理削除を直接storageへ追加せず、既存application ownerへauthority、manifest、idempotencyを足す。

## 必要な schema と service

- Session binding revisionとSession lifecycle event
- root／child placement inputのstrict union
- Session update tuple resolver
- move／adopt transfer planner
- archive stateとdelete manifest
- root作成時のRoot WorkItem、grant、budget atomic owner
- existing GUI update／deleteとAgent APIが共有するapplication service
- runtime catalogのSession capability projection

## Migration

既存Sessionには現在のbindingを`migration_baseline`として一件追加する。既存rootとparent関係、Character runtime identity、Provider thread、Workspaceを変更しない。既存Roleからdefault grant templateを生成するのはgrant migration sliceで行い、本sliceで過大なgrantを推測しない。

## Direct validation

- root作成がSession、Root WorkItem、grant、budgetの片方だけを残さない。
- child作成とroot作成のplacement schemaを混同しない。
- Provider／model／reasoning／catalog revisionとCharacter／runtime snapshotをtupleで更新する。
- binding更新前に開始したTurnが旧revisionへ、更新後のTurnが新revisionへ帰属する。
- moveでcycle、orphan、root不一致、Work Item relation不一致を作らない。
- adoptの各failure pointでsourceとdestinationのどちらも部分更新しない。
- delegation compensationは対象createと相関する未使用childだけを処理する。
- archive、reuse、deleteのidempotent retryとresponse lossを区別する。
- running、queued、child、artifact、grant、budget reservationを含むdelete manifestを検証する。

## Review lens

- GUIの既存update／deleteとAgent APIのauthority差だけがadapterに分散していないか
- Character owner、Memory、affectがSession移管に追従して誤移管されないか
- provider threadとbinding revisionの競合
- move／adopt中のdescendant、Work Item、artifactのowner漏れ
- physical deleteがarchiveまたはdiscardの代替として自動選択されないか
