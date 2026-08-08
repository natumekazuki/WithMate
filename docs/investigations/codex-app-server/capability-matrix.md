# Codex App Server Capability Matrix

- 調査日: 2026-07-10、2026-07-20、2026-07-31、2026-08-01
- 対象 version: live runtimeは`codex-cli 0.146.0`、生成schema baselineは`0.145.0`（既存の基本通信は`0.144.1`、`0.144.6`でも実測）
- 関連設計: `docs/design/provider-integration.md`, `docs/design/codex-app-server-adapter-contract.md`
- 状態: CAS-001〜CAS-016を完了。主要interaction、MCP二段round trip、同一process上で`turn/started`からterminalまでの区間が重なる10 active Runを`gpt-5.6-luna`で実測済み。CAS-017のmanaged daemon lifecycleはWindowsでblocked

## 目的

Codex App Server が WithMate の Provider Adapter に必要な操作と event を提供できるか整理し、設計で採用できる範囲と追加検証が必要な範囲を分ける。

本書は特定 version の調査結果である。正式な実装では起動時に CLI identity と capability を記録し、実際のstable protocol payloadをDecoderとruntime契約testへ通して互換性を確認する。CLI release文字列自体はadmission gateにしない。

## 判定区分

| 区分              | 意味                                                                            |
| ----------------- | ------------------------------------------------------------------------------- |
| 実測済み          | ローカル環境で request / notification を確認した                                |
| 仕様・schema 確認 | 公式仕様と生成 schema で確認したが runtime 未検証                               |
| Experimental      | `--experimental` を付けた schema にのみ存在するか、公式に experimental とされる |
| 対象外            | 初期 WithMate Provider Adapter では利用しない                                   |

## Transport と初期化

| 能力                     | App Server contract                                              | 判定                           | WithMate での扱い                                                                                  |
| ------------------------ | ---------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------- |
| process 起動             | `codex app-server`                                               | 実測済み                       | 長寿命WithMate runtime hostがstdio childとして起動・監視する                                       |
| transport                | stdio 上の 1 行 1 JSON message                                   | 実測済み                       | stdout を protocol 専用、stderr を診断用として扱う                                                 |
| 初期化                   | `initialize` request、`initialized` notification                 | 実測済み                       | 接続確立前の必須 handshake とする                                                                  |
| experimental opt-in      | `initialize.capabilities.experimentalApi`                        | `request_user_input`で実測済み | 対象method、capability、feature evidenceをProvider definitionで固定し、experimental API全体を一括で利用可能にしない |
| protocol envelope        | JSON-RPC 2.0 に近い形式。ただし wire 上で `jsonrpc` field を省略 | 実測済み                       | 汎用 JSON-RPC library を使う場合は省略形式への対応を確認する                                       |
| WebSocket transport      | `codex app-server --listen ws://...`、認証option                 | Experimental                   | `0.145.0`のCLI helpには存在するが、初期実装では採用せずstdio childを使う                           |
| managed daemon lifecycle | `codex app-server daemon`                                        | Windowsでblocked               | `0.145.0`でもUnix限定。初期実装の必須依存にせず、runtime host自身がProvider childを所有する        |

## 会話と実行

| WithMate の要求     | App Server contract                                       | 判定                                           | 設計判断                                                                                                            |
| ------------------- | --------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 新規外部会話        | `thread/start`                                            | 実測済み                                       | WithMate Session の Codex binding に Thread ID を保持する                                                           |
| 外部会話の再開      | `thread/resume`                                           | 実測済み                                       | completed persistent Threadはprocess再起動後に再開できる。stdio process異常終了時のactive Turnは`interrupted`となる |
| 外部会話の取得      | `thread/read`                                             | 実測済み                                       | persistent Threadのcompleted Turnを取得できるが、provider状態の照合に限定し、共通履歴の正本にはしない               |
| 外部会話の一覧      | `thread/list`                                             | 仕様・schema 確認                              | recovery / diagnostics 候補。通常の Session 一覧は WithMate DB を使う                                               |
| 1 回の実行開始      | `turn/start`                                              | 実測済み                                       | WithMate Run と Turn ID を対応付ける                                                                                |
| 実行中の追加指示    | `turn/steer`                                              | 実測済み                                       | `expectedTurnId`不一致とactive Turn不在は`-32600`。一致時は同じTurnへuserMessageを追加する                          |
| 実行中断            | `turn/interrupt`                                          | 実測済み                                       | 空response後の`turn/completed(interrupted)`をuser cancel requestと相関して`canceled`へ変換する                      |
| assistant streaming | `item/agentMessage/delta`                                 | 実測済み                                       | item ID と順序を保って Message draft へ投影する                                                                     |
| assistant phase     | agentMessage `phase=commentary` / `final_answer` / `null` | Lunaでexplicit phaseを実測、`null`はschema確認 | `gpt-5.6-luna`の3 Turnでcommentaryとfinal_answerを各1件確認した。`null`はunknownとしてfallbackする                  |
| item lifecycle      | `item/started`、`item/completed`                          | 実測済み                                       | message / command / file change などの進行を Run event として記録する                                               |
| Turn lifecycle      | `turn/started`、`turn/completed`                          | 実測済み                                       | Run の開始・terminal 判定に使う                                                                                     |
| Thread live state   | `thread/status/changed`                                   | 実測済み                                       | `active` / `idle` は Provider の観測値として保持し、WithMate Run phase / activity の正本にはしない                  |

## 状態

生成 schema で確認した Turn status は次の 4 つ。

| Codex Turn status | WithMate Run phase の初期対応                                                               |
| ----------------- | ------------------------------------------------------------------------------------------- |
| `inProgress`      | `active`。通知内容と pending interaction から activity を投影する                           |
| `completed`       | `completed`                                                                                 |
| `failed`          | `failed`                                                                                    |
| `interrupted`     | user による interrupt の完了を確認できた場合は `canceled`、原因不明の切断時は `interrupted` |

Thread status は少なくとも `active`、`idle`、`systemError` を持つ。Thread status と Turn status は別物として保持し、`idle` だけで Run の正常完了を確定しない。

## Approval と追加入力

| 能力                   | Server request                          | 判定                          | 設計判断                                                                                                     |
| ---------------------- | --------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| command 実行承認       | `item/commandExecution/requestApproval` | accept / decline実測済み      | Run activity を `waiting_approval` へ投影する                                                                |
| file 変更承認          | `item/fileChange/requestApproval`       | accept / decline実測済み      | Run activity を `waiting_approval` へ投影する                                                                |
| permission 承認        | `item/permissions/requestApproval`      | turn scopeで実測済み          | `request_permissions` featureとgranular approvalを検証し、command / file承認とpayloadを混同しない            |
| user input             | `item/tool/requestUserInput`            | option / Other回答を実測済み  | experimental APIとdefault mode featureを検証し、Run activityを`waiting_input`へ投影する                      |
| MCP tool approval      | `mcpServer/elicitation/request`         | plain acceptで実測済み        | metadataの`codex_approval_kind=mcp_tool_call`で識別し、永続choiceを選ばない回答を別interaction kindとして検証する |
| MCP server elicitation | `mcpServer/elicitation/request`         | direct / model Turnで実測済み | `codex_approval_kind`なし、`mode=form`だけをbounded formとして投影し、tool approvalや未知variantと混同しない |
| request 解決通知       | `serverRequest/resolved`                | 実測済み                      | request単位のpending state解消に使う。tool result、item terminal、Turn terminalとは別の事実として扱う        |

App ServerからWithMateへのserver requestは通常のnotificationと異なり、WithMateが同じrequest IDへresponseを返す必要がある。`request_permissions`は`features.request_permissions_tool=true`、default modeの`request_user_input`は`features.default_mode_request_user_input=true`を必要とした。experimental server requestを扱う接続は`initialize.capabilities.experimentalApi=true`を宣言する。

permissionとuser inputのrequestはThread / Turn / item IDを持つが、`codex-cli 0.145.0`の生成bindingでは専用`ThreadItem` variantを持たない。request owner、`serverRequest/resolved`、Turn terminalを追跡し、command / file approvalと同じitem terminalを要求しない。user inputのcurrent Provider payloadにある`isOther=true`はpublic snapshotの必須boolean `allowOther=true`へ投影する。current option labelとboundedな自由入力Otherの両方をlive Turnで回答し、resolvedとTurn terminalまで完了した。

MCP tool approvalとserver formのrequestはexactなThread / Turn IDを持つがitem IDを持たず、対応するMCP itemの`item/started`より前にも到達できる。request ownerと`serverRequest/resolved`をThread / Turnで追跡し、後続のMCP tool call item lifecycleとTurn terminalを別の事実として検証する。

MCPの先行probeが停止した原因は、同じmethodで届くMCP tool approvalをserver formとして扱い、schema不一致でdeclineしたことだった。metadataの`codex_approval_kind`でtool approvalを分離し、空contentのplain accept後に届くserver formへkind固有回答を返すと、fixture response、tool result、`item/completed`、`turn/completed`まで完了した。stable protocolは`_meta`を定義し、`0.145.0`のlive probeでは`meta` aliasも観測したため、両方を同じschema-evidenced inputとして扱う。未知の`codex_approval_kind`またはdiscriminatorなしの非form modeは回答対象へ投影しない。server formのacceptはvalidated field valuesをcontentへ変換し、decline / cancelは`content: null`とする。利用可否はProvider definitionがsemantic definition version、capability、feature、runtime evidenceから公開し、共通層がmethod名やCLI releaseだけでkindやresponse shapeを判断しない。

公開snapshotではProvider item IDをopaque interaction IDの内部相関へ閉じる。file changeの表示pathはslash区切りのworkspace相対pathへ安全に正規化でき、change kindが既知の場合だけ回答可能とする。absolute、drive-qualified、parent-relative、backslash、Unicode control、bidi controlを含むpath、未知change kindはunavailableとし、表示を切り詰めて回答させない。

## Model と capability

| 能力                | App Server contract                          | 判定     | 設計判断                                                                                                  |
| ------------------- | -------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| model 一覧          | `model/list`                                 | 実測済み | model ID、表示名、reasoning effort、入力 modality などを取得できる                                        |
| Luna実行tuple       | `model=gpt-5.6-luna`、`reasoningEffort=high` | 実測済み | catalog上のexact model ID、default、supported effortをpreflightで照合し、全live Turnへ同じtupleを明示する |
| Provider capability | `modelProvider/capabilities/read`            | 実測済み | `0.145.0`では`imageGeneration`、`namespaceTools`、`webSearch`がすべて`true`。起動時feature gate候補       |
| pagination          | `cursor`、`limit`                            | 実測済み | catalog refresh は全 page を取得する                                                                      |
| hidden model        | `includeHidden`                              | 実測済み | 通常一覧7件、hiddenを含む完全一覧8件、hidden 1件を確認。Lunaはhiddenではない                              |

## Provider 履歴を正本にしない理由

生成 schema では、Thread の `turns` は `thread/read(includeTurns=true)` など一部操作でのみ読み込まれる。また、永続化された Thread item は lossless な event ledger ではなく、command execution など一部 interaction が保持されない場合がある。

このため次を設計上の前提とする。

- WithMate の Session / Message / Run event を表示・監査用履歴の正本にする。
- Codex Thread は Codex 側で会話を継続するための外部状態として扱う。
- reconnect 時の `thread/read` は照合・復旧補助に使い、WithMate 履歴を全面的に再構築する用途には使わない。
- 未知 event を破棄せず、sanitize した診断情報を残す。

## Experimental schema の扱い

`--experimental`付きschemaではprocess制御、Thread item / Turn一覧、remote control、一部realtime requestなどの追加APIが生成される。`codex-cli 0.144.6`では`turn/steer`、`turn/interrupt`、agentMessage phaseはstable schemaに存在した。default modeの`request_user_input`はexperimental opt-inを必要とするため、初期Provider Adapterはexperimental API全体へ依存せず、versionと契約testを持つ対象methodだけを明示的に有効化する。

## App Server protocolだけでは確定しない境界

- Provider側timeoutは安定したwire eventとして観測できないため、WithMate client deadlineとpending interactionの失効規則を正本にする。
- `serverRequest/resolved`後の同一response再送は、追加errorも副作用も発生せずTurnが一度だけ完了した。ただし再送自体への独立ACKはprotocolにないため、受理か拒否かは断定せずidempotentなclient処理を要求する。
- response write後またはresolved後にtransportが切れてterminal eventを失うと、App Server eventだけでは副作用の最終結果を確定できない。Runをambiguous / interruptedとして保持し、必要な外部照合を別契約にする。
- runtime host local IPCのclient-only切断、response loss、subscription再接続、stale endpointはWithMate内部contractであり、App Server検証とは分離する。
- 同一process上の10 active Runは、exactなThread / Turn tupleごとに`turn/started` 1件と`turn/completed` 1件を持ち、10区間すべてがterminal前に開始済みとなる最大同時active数10を示した。相関混線なく完了したため10を支持下限とするが、絶対上限、backpressure、resource limitはhost / account / model / version依存なので、Provider definitionとruntime hostが明示的な上限を所有する。
- `modelProvider/capabilities/read`とmodel catalogは`0.145.0`で実測した。version差分は実payloadの起動時preflightと契約testで検知し、現在値を将来versionへ固定値として一般化しない。
- agentMessage `phase=null`はstable schemaで許容されるが、Lunaの3 Turnでは発生しなかった。fallback mappingはsynthetic executable contractで固定する。
- 未知notificationはsynthetic client self-testで、既知eventの処理を継続し、public diagnostic projectionをraw method / payloadを含まないboundedかつsanitizedな`other`へ落とすことを確認した。受信時の内部bufferにraw wire messageが存在しないことまでは主張しない。

## 参照

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- `docs/investigations/codex-app-server/validation-plan.md`
- `docs/investigations/codex-app-server/validation-results.md`
