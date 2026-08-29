# Shared authority と履歴基盤

## 担当する能力

この slice は、後続する Session、Work Item、artifact、root、budget の全 mutation が共有する principal、grant、revision、event、effect certainty の基盤を提供する。個別 resource の操作は実装しない。

## Canonical owner

- runtime binding service: actor Session と runtime generation を解決する。
- authority grant service: actor の active grant と resource scope を評価する。
- resource service: expected revision と resource 固有不変条件を評価する。
- storage transaction: current projection、event、idempotency result を原子的に保存する。

Role は grant 作成時の template だけを提供し、認可時は保存済み active grant を評価する。Role の変更だけで既存 grant を暗黙に増減させない。

## Principal と authority

principal は少なくとも次を区別する。

- `user`: trusted GUI を通じて確認されたユーザー操作
- `agent`: valid runtime binding を持つ Session actor
- `system`: migration、repair、retention、reconciliation の限定 service principal

Agent request が指定できるのは target resource と requested action である。actor、root、owner、grant issuer は request body から採用しない。

grant は次の tuple を持つ。

- stable grant ID
- issuer principal と issuer grant
- grantee Session
- resource scope
- action set
- external side-effect class
- budget allocation reference
- issued、effective、expires、revoked timestamp
- revision と event sequence

子 grant の action、scope、有効期間、budget は issuer の実効 grant の部分集合にする。複数 grant の和集合は許可するが、一つの request を許可した根拠 grant ID を audit event に記録する。

新規resourceを作るauthorityは、既存resource IDの集合ではなくplacement namespaceへのconstruction capabilityとして表す。root作成grantは、作成可能なroot kind、Workspace／Project境界、初期visibility、付与可能actionの上限、budget ceiling、expiryを持つ。生成したroot grantはこのconstruction capabilityとissuerのdelegable action／budgetの積集合から導出し、作成元grantとoperation IDをprovenanceへ保存する。新しいroot IDをwildcardへ暗黙追加しない。

## User decision と interaction policy

既存を含む全Agent-facing operationとprovider interactionは、保存済みdecision classを次のいずれかへ分類する。request側からclassを指定または格上げできない。

- `user_only`: trusted GUIが発行したuser-principal receiptだけで解決できる。
- `agent_delegable`: action、resource scope、external side-effect classを含むactive grantの範囲でAgentが回答できる。
- `deny_or_cancel`: Agentは回答できず、cancel、escalate、待機だけを選べる。

`interaction.respond`は対象interactionに保存されたclassを参照する。`coordination.event.resolve`はAgent自身のblocker／escalation解決としてagent provenanceを保持し、`user_decision_required`へのuser responseには使わない。provider approval、elicitation、外部副作用確認も同じregistryへ載せ、未分類interactionはfail closedする。trusted GUI receiptはuser principal、対象interaction ID、選択または回答、revisionをMain Processで発行し、Agent向けadapterから作成できない。

## Mutation envelope

effect-bearing operationは一つの形へ押し込まず、次の三つへ分ける。いずれもprincipal単位のidempotency key、operation固有payload、必要なgrant／budget revisionを持つ。

- create: canonical containerまたはplacement namespaceとexpected revisionを検証し、resource IDはserver側で予約する。
- existing-resource mutation: target resource IDとexpected resource revisionを検証する。
- saga: operation IDとexpected operation revision、step precondition、server-reserved resource IDs、committed manifest、recovery stateを検証する。

共通の処理順は次とする。

1. runtime binding と principal を解決する。
2. canonical container、target resource、またはoperation identityとcurrent revisionを取得する。
3. active grant と budget を評価する。
4. operation 固有不変条件を検証する。
5. create／existing mutationはtransaction内でprojection、event、idempotency resultを保存する。sagaはoperation revision、完了step、committed manifest、次のrecovery stateを各stepのtransactionで保存する。
6. commit 後に publication を行う。
7. response loss 時は同じ key と payload で replay する。

authorization failureとstale revisionを区別する。stale revisionをauthority failureへ読み替えず、callerがcurrent stateをread-backして再判断できるerror detailを返す。sagaのeffect certaintyはoperation全体を`none`へ丸めず、committed manifestとstepごとの`none | committed | unknown`を返す。

## Event contract

resource event は共通 header と resource 固有 payload を持つ。

- event ID、resource kind、resource ID
- root ID、owner kind、owner ID
- event kind と resource revision
- principal kind、actor Session ID、grant ID
- operation ID、idempotency key fingerprint
- occurred、committed timestamp
- supersedes event ID または null
- payload schema revision

訂正は旧 event を削除せず、新 event の `supersedes` で表す。current projection は active event chain から構成できなければならない。

## 必要な schema と service

- versioned authority grant table と grant event table
- resource event の共通 header contract
- principal resolver
- grant subset evaluator
- shared mutation admission helper
- decision class registryとtrusted GUI user receipt
- saga operation revision、step、manifest、recovery stateの共通contract
- effect certainty と idempotency result の共通 type
- current projection と event replay の consistency verifier

一つの巨大な多態 event tableへ全 payloadを無制限に詰め込まない。共通 header と resource 固有 event storage のどちらを採るかは、query、migration、retention を比較して ADR で確定する。

## Baseline migration と authority cutover

baseline active grantのmigrationとRole authority ceilingの無効化は、同じshared authority cutover sliceで行う。既存全operationについてaction、resource scope、effect class、decision classのmappingをcanonical registryへ用意し、未分類operationが一つでもあればcutoverしない。

migrationは既存Sessionのcurrent Roleと現行operation contractから、移行前に実際に許可されていた範囲だけをbaseline active grantとして生成する。新しいroot construction、cross-root、delete、外部副作用などの能力を推測して加えない。baseline eventへ旧Role binding、mapping revision、生成根拠を保存する。

startupはschema migration、grant backfill、mapping verifierが成功してからAgent-facing application serviceを開始する。cutover後は全operationをgrant evaluatorへ通し、Role fallbackを残さない。失敗時はserviceを開始せず`migration_required`とrepair対象を返す。slice 10は残存Role分岐の削除、default template、表示、Skillの整理だけを行い、authority cutoverを延期しない。

## Failure timing

- grant evaluation前に mutation用resourceを作成しない。
- grant revokeとmutation commitが競合した場合は、同じtransactionで参照したgrant revisionを記録する。
- commit後publication failureは `effect: committed` とresource ID、revisionを返す。
- timeout後の別payload再送は idempotency conflict とする。
- owner削除後もretention中のevent、idempotency、remote cleanupに必要なidentityを保持する。

## Direct validation

- child grantがaction、scope、expiry、budgetの各軸で親を超えない。
- root construction capabilityから生成したgrantがaction、visibility、budget、expiryの上限を超えず、新root IDをwildcardへ追加しない。
- `user_only` interactionをAgent principalで回答できず、trusted GUI receiptをAgent adapterから偽造できない。
- `agent_delegable` interactionは必要なgrantとeffect classを満たす時だけAgent principalで回答できる。
- revoke済みまたはstale grantで新規mutationを開始できない。
- commit中にrevokeされたmutationの結果と根拠revisionが一意に決まる。
- actor、owner、root、issuerのspoof fieldをraw adapterから受理しない。
- createとexisting-resource mutationでprojection、event、idempotency resultがfailure injectionによって部分保存されない。
- sagaの各failure pointでoperation revision、committed manifest、effect certainty、recovery stateが一致する。
- event replay結果とcurrent projectionが一致する。
- 同一key replayと別payload conflictを全resource共通contractで検証する。
- populated databaseのbaseline grant backfillと既存全operation mappingを検証し、未分類operation、過大grant、Role fallbackを拒否する。

## Review lens

- grant subset判定の抜け道
- construction capabilityによる新規resource scopeの暗黙拡張
- user receiptとAgent response provenanceの混同
- Role templateとactive grantの混同
- stale runtime generationまたはcross-root identityの誤接続
- private fieldを含むaudit payloadのpublic projection漏れ
- revoke、retry、cleanupの到着順によるauthority拡張
