# Result と aggregation correction

## 担当する能力

- terminal resultの訂正
- aggregation decisionのcorrect、revoke、replace
- nested aggregationのbounded flatten projection
- aggregate snapshotと親resultのfinalize
- 訂正後の再集約と再finalize

## 公開操作候補

| Capability | Operation candidate | 契約 |
| --- | --- | --- |
| result訂正 | `work.result.correct` | 旧resultをsupersedeする新result revision |
| decision訂正 | `work.aggregation.correct` | `revise | withdraw | replace` unionで旧decisionをsupersede |
| flatten取得 | `work.aggregation.list`拡張 | depth、cursor、field上限付きread projection |
| 親確定 | `work.result`拡張 | aggregate snapshotと親resultを原子的に確定 |

decisionのrevise、withdraw、replaceは一つのstrict correction unionへ統合する。API数ではなく、全状態遷移を曖昧さなく表現できることを優先する。

## Result correction

旧result rowを更新しない。新resultは次を持つ。

- result revision
- superseded result ID
- correction reason
- corrected summary、changes、verification、findings、unverified、remaining work
- reporting principalとgrant
- source／execution revision

result correction後、旧resultをacceptedしたactive decisionはstaleとなる。自動で新resultをacceptedにせず、親ownerへ再decisionを要求する。親がterminalなら、親result correctionまたはsuccessor aggregationを同じworkflowで行う。

## Decision correction

decisionはappend-only event chainとして扱う。current decision projectionはactive eventを一件だけ持つ。

- correct: accepted、excluded、retry_requestedの種類または理由を変更する。
- revoke: active decisionを失効し、childをundecided terminalへ戻す。
- replace: old childのdecisionをsupersedeし、replacement childとのrelationを確定する。

decision mutationはchild result revisionとparent aggregate revisionをexpected値として要求する。古いresultを見て行った訂正をcommitさせない。

## Flatten projection

flattenはmutation ownerを変えないread projectionである。root coordinatorが全descendantの状態、result summary、decision chain、provenanceを確認できるようにするが、孫decisionをrootが直接変更するauthorityを暗黙に与えない。

入力は最大depth、state／decision filter、field projection、cursorを持つ。full result payloadを全件hydrateせず、必要なresultは`work.get`またはresult get operationで取得する。

## Finalize

finalizationは既存の`work.result`へ収束させる。集約を持つ親の`work.result`は次を同じtransactionで行う。

- current aggregate revision、全active decision、child result revisionを検証する。
- 親result revisionを保存する。
- aggregate finalized eventを保存する。
- idempotency resultを保存する。

子を持たないWork Itemは`work.result`を維持できる。公開操作を統一する場合は、application service内部で同じfinalization ownerへ収束させる。

## 訂正後の状態

finalize後にresultまたはdecisionを訂正すると、親aggregateは`stale` projectionになる。旧finalized resultは履歴として残し、次を完了するまでcurrent final resultとして扱わない。

1. stale原因を列挙する。
2. 必要なdecisionを再確定する。
3. 親resultをcorrectする。
4. 新aggregate revisionをfinalizeする。

stale中に親resultを下流へ新規採用させない。既に下流で採用済みの場合はstalenessを上位へ伝播し、最上位まで訂正可能にする。

## 必要な schema と service

- versioned result identityとresult event
- versioned aggregation decision event
- active decision projectionとstale aggregate projection
- descendant flatten query
- finalize transaction
- correction propagation／staleness service
- public summaryとfull resultの分離

## Migration

既存resultとimmutable decisionをrevision 1のbaseline eventとして保持する。現在のaccepted／excluded／retry_requestedを変更しない。既存terminal parentはfinalized baselineとして扱い、後から訂正された場合だけstaleへ遷移する。

## Direct validation

- result correctが旧resultを保持し、current projectionだけを新revisionへ向ける。
- stale child result revisionでdecision correctをcommitできない。
- revoke後にundecided countとparent finalization条件が一致する。
- replaceがold child、replacement、retry decisionのprovenanceを失わない。
- flattenがdepth、cursor、response size、visibilityを守る。
- finalize transactionのfailure injectionでresultとaggregate eventの片方だけが残らない。
- terminal parent訂正時にstalenessが上位へ伝播する。
- response loss後のcorrect／finalize replayが重複revisionを作らない。

## Review lens

- immutable historyとmutable current projectionの混同
- correction propagationが途中のparentで停止する経路
- flatten read authorityからmutation authorityが派生していないか
- stale aggregateをcurrent final resultとして公開するprojection
- retry replacementとdecision replaceの二重provenance
