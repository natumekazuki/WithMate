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

## 共通 mutation envelope

全 effect-bearing operation は次を要求する。

- target resource ID
- expected resource revision
- principal 単位の idempotency key
- operation 固有 payload
- 必要な grant または budget revision

処理順は固定する。

1. runtime binding と principal を解決する。
2. canonical resource identity と current revision を取得する。
3. active grant と budget を評価する。
4. operation 固有不変条件を検証する。
5. transaction 内で projection、event、idempotency result を保存する。
6. commit 後に publication を行う。
7. response loss 時は同じ key と payload で replay する。

authorization failure と stale revision を区別する。stale revision を authority failureへ読み替えず、caller が current state を read-backして再判断できる error detail を返す。

## Event contract

resource event は共通 header と resource 固有 payload を持つ。

- event ID、resource kind、resource ID
- root ID と owner ID
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
- effect certainty と idempotency result の共通 type
- current projection と event replay の consistency verifier

一つの巨大な多態 event tableへ全 payloadを無制限に詰め込まない。共通 header と resource 固有 event storage のどちらを採るかは、query、migration、retention を比較して ADR で確定する。

## Failure timing

- grant evaluation前に mutation用resourceを作成しない。
- grant revokeとmutation commitが競合した場合は、同じtransactionで参照したgrant revisionを記録する。
- commit後publication failureは `effect: committed` とresource ID、revisionを返す。
- timeout後の別payload再送は idempotency conflict とする。
- owner削除後もretention中のevent、idempotency、remote cleanupに必要なidentityを保持する。

## Direct validation

- child grantがaction、scope、expiry、budgetの各軸で親を超えない。
- revoke済みまたはstale grantで新規mutationを開始できない。
- commit中にrevokeされたmutationの結果と根拠revisionが一意に決まる。
- actor、owner、root、issuerのspoof fieldをraw adapterから受理しない。
- projection、event、idempotency resultがfailure injectionで部分保存されない。
- event replay結果とcurrent projectionが一致する。
- 同一key replayと別payload conflictを全resource共通contractで検証する。

## Review lens

- grant subset判定の抜け道
- Role templateとactive grantの混同
- stale runtime generationまたはcross-root identityの誤接続
- private fieldを含むaudit payloadのpublic projection漏れ
- revoke、retry、cleanupの到着順によるauthority拡張
