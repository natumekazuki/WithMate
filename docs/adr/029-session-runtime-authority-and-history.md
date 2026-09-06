# ADR 029: Session Runtimeの認可と履歴をgrantとresource eventへ切り替える

## Status

Accepted

ADR 026とADR 028のうち、Roleとcommunication policyを実効権限の上限とする判断を置き換える。Sessionのimmutableな親子関係とRoot Work Itemの一意性は維持する。

## Context

既存のSession Runtime操作は、Roleによる許可判定とresource固有の永続化に分かれている。委譲後の権限縮小、ユーザー本人の判断、競合時の履歴を一つの基準で追跡するには、実行主体と認可根拠をmutationのtransactionまで届ける必要がある。

SQLite接続はresource storageごとに独立している。application serviceで認可した時点とstorageがcommitする時点の間にgrantが変わる可能性があるため、入口の判定だけではcommitの根拠にならない。

## Decision

- Agentのprincipalはruntime bindingと現在のexecution generationから解決する。root、owner、resource identityは保存済み関係から取得する。requestのprincipalやRoleを認可に使わない。
- 既存operation registryの全操作をaction、scope、effect class、decision classへ対応付ける。Roleはbaseline grantのtemplateとして保存し、通常の認可はactive grantとその委譲元の状態を評価する。baseline migrationは既存のroot内関係と実効権限を超えない。
- application serviceは解決済みのmutation proofを明示引数でstorageへ渡す。storageは同じ書き込みtransaction内でgrant revisionとscopeを再検証し、resourceのprojection、固有event、共通event header、idempotencyを保存する。暗黙の実行コンテキストやRole fallbackは使わない。
- 共通event headerはresource identity、owner、principal kind、grant revision、operation、effect certaintyを所有する。resource固有payloadは各resourceのevent tableに置く。共通tableへ任意payloadを集約しない。
- Session と execution のresource固有payloadはschema revision 2でrevision適用後のcanonical projection snapshotを保存する。startup verifierはheaderのschema revisionを確認し、event replay結果をcurrent rowと照合する。既存projectionのmigration baselineも同じ完全なsnapshotとし、暫定的な空payloadを後から補う経路は持たない。
- ユーザー専用判断は保存済みdecision classで区別する。providerのapprovalとelicitationはユーザー専用とし、Agentからの応答を拒否する。GUIのtrusted responderはAgent向けapplication serviceへ公開しない。
- filesystem publishとprovider実行は、admissionと結果確定を分けて記録する。既にadmitした処理の回復では、保存したoperation identityとeffectの証拠を使い、結果が不明な状態を成功へ変換しない。
- migrationは既存projectionのbaselineを記録する。過去の判断主体や応答を証明できないledgerから、ユーザーreceiptやcanonical responseを捏造しない。

## Consequences

公開操作の入力revisionとcatalogの意味はTypeScript、HTTP、CLI、MCP、managed Skillで同時に変更する。旧入力の救済経路は追加しない。子Role一覧はbaseline templateとして公開し、現在の許可一覧とは扱わない。

Work Item の非 root 可視性はcreatorまたはtargetへ限定する。listは両関係の和集合を一つのgrant relationとして評価し、getはassignedとcreatedを別grantとして評価する。root member可視性はoverall coordinatorの明示grantでのみ追加する。

Slice 1ではgrant、decision、revision、historyの切り替えを行う。root budget ledger、reserve、reconcile、admissionはユーザー承認済みの段階導入に従いSlice 2へ残す。無制限allocationや成功するbudget stubは置かず、既存のoperation limitを維持する。

provider自身のshell、Git、外部toolはSession Runtime APIを迂回できる。ここでのgrant enforcementはWithMateの公開Runtime操作に限られ、providerのapprovalとsandboxは別の境界である。この制約はruntime catalogと実装planへ明記する。

## Alternatives

### Role判定とgrant判定を併用する

固定Roleが引き続き認可の上限となり、grantへ切り替える目的を満たさないため採用しない。

### 暗黙のコンテキストでproofを共有する

resourceごとのSQLite transactionとの関係が呼び出しから分からなくなる。明示引数でadmissionの根拠を渡す方式を採用する。

### 全resourceのpayloadを共通event tableに格納する

resource固有のvalidationとprojectionを一つの任意JSON境界へ移す必要が生じる。共通headerと固有payloadの責務を分ける。

## References

- `docs/plans/20260830-agent-autonomy-capability-expansion/designs/00-shared-authority-and-history.md`
- `docs/plans/20260830-agent-autonomy-capability-expansion/designs/08-resource-budget.md`
- `docs/plans/20260830-agent-autonomy-capability-expansion/designs/09-public-api-migration-and-review.md`
