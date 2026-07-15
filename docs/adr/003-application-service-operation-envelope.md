# ADR 003: Application Service operation境界とresponse envelope

- Status: Accepted
- Date: 2026-07-14

## Context

CP2ではCLIと将来のGUIが同じApplication Serviceを利用する。Persistence Workerのwriteはdomain rejectionをtyped resultとして返す一方、readのscope rejectionとtransport / database failureはどちらも`PersistenceClientError`経路を通る。また、bounded readには一部itemを省略した有効なpageがあり、Provider実行を含む後続operationではdomain outcomeの確定後にpersistenceだけが失敗する場合もある。

これらを単一のerrorやboolean successへ畳むと、callerは再試行すべき対象、commitの確実性、部分的に利用できる結果を区別できない。authorizationの具体的なclaim構造をApplication Service contractへ固定すると、CLI、GUI、Electron IPCなどtransportごとの認証方式まで共通use caseへ持ち込むことになる。

Session作成ではApplication ServiceがWithMate Session IDを発行する必要がある。一方、Repositoryのidempotency fingerprintはSession IDを含むため、exact retryごとにrandom IDを発行すると同じidempotency keyが異なるrequestとして競合する。

## Decision

Application operationは`success`、`partial_success`、`failure`をdiscriminated unionとして返す。`partial_success`は利用可能なvalueとboundedなissueを持ち、domain rejectionやpersistence failureを表す`failure`とは混同しない。

各responseはdomain outcomeとは別にpersistence statusを持つ。statusは未実行、read完了、commit完了、domain rejection、persistence failureを区別し、failureでは既存の`none` / `unknown` effectを維持する。`unknown`をcommit済みまたは未commitと推測しない。

request validation、workspace validation、authorization rejection、domain rejection、persistence failure、Application内部失敗は別のerror kindとする。read経路の`request_invalid`、`cursor_invalid`、`not_found`だけはdomain rejectionへ写像し、それ以外の`PersistenceClientError`はpersistence failureとして保持する。

Application contractはPersistence Worker固有のrequest optionやerror codeを公開しない。timeout / cancel optionはApplication所有型で受け、persistence errorはunavailable、busy、timeout、canceled、configuration、integrity、response size、operation failureの安定codeへ写像する。failure effectとretryableは失わない。

authorization contextはgenericなoperation contextとして受け、workspace validationとauthorizationを行う注入portへ渡す。Application Serviceは両方のvalidationをRepository呼び出し前に実行し、Persistence Workerへ認証主体を渡さない。

write operationのidempotency keyはcallerがcanonical lowercase UUIDとして供給する。Session IDはApplication Serviceがidempotency keyからnamespace付きSHA-256で安定発行する。これによりtransport callerへRepository commandやID生成を委ねず、process再起動後のexact retryでも同じsemantic commandを再構築する。

Repository read / write client、write command型、raw requestを送信できるPersistence Worker clientはApplication Serviceの内部統合面とし、public Main barrelから公開しない。public Main barrelはApplication operation interfaceだけを公開し、Application Service実装classとDI optionsも内部統合面に留める。static module-boundary checkはPersistence Worker subsystemとPersistence Worker / Repository client自身を除く全sourceを走査し、Application Service以外からのRepository clientのstatic / dynamic importとcall、command型import / re-exportを拒否する。raw Persistence Worker requestはApplication Serviceを含む統合層からも拒否し、public Main barrelのexportは宣言元まで追跡して内部統合面の再公開を拒否する。Repository resultとaccess rejectionはApplication responseの既知fieldへ明示的に写像し、将来追加された内部fieldを素通ししない。

現在のfield、operation一覧、validation rule、Repository mappingはshared type、source、contract test、module-boundary checkを正本とする。

## Alternatives

- すべてを例外へ変換する: domain rejection、partial result、commit不明のpersistence failureを区別できないため採用しない。
- `ok: boolean`とnullable value / errorを使う: 不正な組合せを型で排除できず、partial successの意味も曖昧になるため採用しない。
- authorization claimを固定schemaとして共通contractへ定義する: transportや認証方式の未決定事項を先取りするため採用しない。
- Session IDをoperation callerに発行させる: Repository write commandのidentity組み立て責務がCLIやGUIへ分散するため採用しない。
- exact retryごとにrandom Session IDを発行する: Repository fingerprintが変わり`idempotency_conflict`になるため採用しない。
- process内cacheでidempotency keyとSession IDを対応付ける: 再起動後に同じcommandを再構築できないため採用しない。

## Consequences

- CLIとGUIは同じoperation responseからdomain、access、persistence、partial resultを一意に判定できる。
- CLIとGUIはPersistence Workerのrequest option、database固有error、Repository write commandを共通contractとして扱わない。
- write timeoutやWorker crashの`effect='unknown'`は成功扱いされず、同じoperation requestのexact retryで収束できる。
- authorization方式を後から追加・変更してもSession use case contractを作り直さずに済む。
- Session IDはidempotency keyに対して決定的だが、namespace付きhashによりkeyそのものやProvider IDをresource IDとして公開しない。
- idempotency keyを異なるcreate requestへ再利用すると同じSession ID候補になるが、Repository fingerprint検証が`idempotency_conflict`として拒否する。
