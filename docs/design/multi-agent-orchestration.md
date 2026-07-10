# Multi-Agent Orchestration

- 作成日: 2026-07-10
- 対象: WithMate 新実装の Multi-Agent 起動、待機、結果配送、親子 Session 相関
- 状態: 設計の基準
- 関連設計: `docs/design/session-run-message-contract.md`, `docs/design/provider-integration.md`
- 参考 Issue: GitHub #222, #29, #74, #52, #283

## 目的

呼び出し元 Agent が、目的に応じて別 Agent へ処理を委譲し、同期・並行・バックグラウンドの実行方法を自ら選べる共通 contract を定義する。

WithMate は特定の役割や実行トポロジーを固定せず、Session の作成、親子関係、実行状態、待機、結果回収、キャンセル、永続化を提供する control plane として振る舞う。

本書では責務、不変条件、実行パターン、結果配送を定める。DB table、CLI command、Hook protocol の具体的な型は後続設計で確定する。

## 確定方針

1. 通常利用と Multi-Agent 利用で Session の種類を分けない。
2. 子 Agent も通常と同じ Session / Run / Message contract を使う。
3. Multi-Agent の利用方針と操作方法は、アプリが注入する Hook prompt の切り替えで Agent へ案内する。実際の操作可否は Application Service の capability / authorization 検証で制御する。
4. 委譲の目的、子の役割、子の数、同期・非同期、待機位置は呼び出し元 Agent が判断する。
5. WithMate はレビュー、調査、実装などの目的別 workflow や固定トポロジーを持たない。
6. 同期・非同期を Session 属性や Session 種別として保存しない。
7. 子の完了結果を、実行中の親 Session へ unsolicited message として挿入しない。
8. 子の結果本文は子 Session を正本とし、親側には relation、参照、配送状態を保持する。
9. Auxiliary は Multi-Agent と別の機能であり、実行中は親 Session をブロックする。
10. 子 Session は WithMate DB の通常の Session として永続化し、粗い実行状態を Session row に保持する。
11. 親は複数の子を起動でき、子もさらに子を起動できる。上限は最上位の親 Session 単位で、その配下の実行中 child Session 合計に適用する。
12. 上限超過時は queue を作らず、起動要求へ即座に retryable error を返す。
13. 子の Character は WithMate がランダムに割り当て、呼び出し元 Agent の意思決定へ割当先を公開しない。
14. Agent 間の指示明確性評価と成果評価は Hook prompt による任意の soft control とし、集計は CLI から明示登録された評価 record だけを対象にする。
15. WithMate は Agent が変更した file の diff、作業領域分離、commit ownership を管理しない。
16. Provider の存在は orchestration API へ露出せず、Agent は model、対応する reasoning depth、特徴、過去評価の分析結果から選択する。

## 非目標

- WithMate が Agent の役割分担や手順を決定すること。
- `review child`、`delegated child` などを domain 上の Session 種別にすること。
- 子の完了を契機に、親 Agent の新しい turn を無条件で自動開始すること。
- 完了した子の結果全文を、次の親 turn へ無条件で自動注入すること。
- 旧実装または GitHub #222 の API、DB schema、workflow をそのまま移植すること。
- 子ごとの token / monetary budget を計測・強制すること。
- 同一 workspace での file 変更競合、diff、merge、commit を WithMate が解決すること。

## 概念モデル

```text
Parent Session
├─ Parent Run
├─ SessionRelation 1..N
├─ Delegation 1..N
└─ Child Session 1..N
   ├─ persisted execution projection
   ├─ ProviderBinding
   ├─ Message 1..N
   ├─ Run 1..N
   └─ SessionRelation / Delegation 0..N

ChildResultDelivery
├─ parent Session / created-by parent Run
├─ child Session / terminal Run
├─ delivery state
├─ collected-by parent Run 0..1
└─ result reference
```

### SessionRelation

親子関係と相関情報を表す。Session の種類を変更するものではない。

最低限、次を追跡できるようにする。

- 親 Session ID
- 起動元の親 Run ID (`createdByParentRunId`)
- 子 Session ID
- 子を起動した操作の correlation ID
- 作成日時
- 任意の呼び出し元指定ラベルまたは目的 summary

ラベルは観測・表示・Agent の整理に利用できるが、`review` や `delegated` などの文字列によって WithMate の実行挙動を切り替えない。

すべての relation は、木の最上位にある Session ID を `orchestrationRootSessionId` として保持する。直接の親は `parentSessionId`、一番親は `orchestrationRootSessionId` で区別する。本書で同時実行上限の「Workspace」と呼ぶ範囲は、この最上位 Session を root とする orchestration tree であり、filesystem workspace path は上限集計の identity に使わない。

### Delegation

親 Agent から子 Agent への 1 件の依頼と、その進行状態を表す。Session の会話 lifecycle、Run の実行 phase、結果配送状態のいずれとも兼用しない。

最低限、次を追跡する。

- Delegation ID
- parent / child Session ID
- `createdByParentRunId`
- 実行する具体的な instruction
- UI 表示用の mention text
- workflow status
- terminal child Run ID または継続に使う latest child Run ID
- result reference と delivery ID

初期 workflow status は少なくとも `running`、`clarification_required`、`result_available`、`collected`、`canceled`、`interrupted` を区別できるようにする。子が曖昧な指示を差し戻した場合、子 Run と Session execution projection は `completed` になり得るが、Delegation は `clarification_required` のまま残る。親が指示を補足すると、同じ child Session に新しい Run を開始して Delegation を継続できる。

### Session execution projection

通常 Session と child Session は同じ Session table に保存する。Session row には `lifecycleStatus` と、`not_started` / `running` / `completed` / `failed` / `canceled` / `interrupted` の粗い `executionState`、`activeRunId`、`latestRunId` を保持する。

これは CLI / UI の一覧、Kill 対象の特定、crash recovery に利用する永続 projection である。詳細な実行状態は Run を正本とし、矛盾した場合は Run から Session projection を修復する。field と不変条件の詳細は `docs/design/session-run-message-contract.md` を正本とする。

### ChildHandle

子 Session を開始した直後に呼び出し元へ返す安定した参照。少なくとも子 Session ID と correlation ID を含み、待機、状態取得、結果回収、キャンセルに使用する。

### ChildResultDelivery

子の実行結果が親から回収可能かを表す配送状態。会話 Message ではない。

```text
pending -> available -> collected
             |
             +--------> expired
```

- `pending`: 子に terminal outcome がない。
- `available`: terminal outcome と結果参照が確定し、親から回収できる。
- `collected`: 結果を取得した親 Run (`collectedByParentRunId`) と取得時刻が確定した。
- `expired`: child Session が retention / delete policy により参照不能になった。配送 tombstone と診断情報は残す。

結果を返す `wait` / `collect` は、結果参照を親 Run の RunEvent / tool result に関連付け、配送状態を `collected` にする 1 つの冪等な Application Service 操作として扱う。操作は collecting parent Run ID と idempotency key を受け取り、応答送信直前に切断しても同じ結果 envelope を再送できるようにする。`StillRunning` を返す wait は配送状態を変更しない。

回収済みでも同じ idempotency key には同じ結果を返す。結果本文は child Session を正本とするため、child Session が参照可能な間は別の親 Run からも Session ID / Delegation ID を使って再取得できる。`collected` は再取得禁止ではなく、親が一度結果を受領したことを示す配送状態である。

child Session が retention または明示 delete によって参照不能になった場合だけ `expired` へ遷移し、結果本文を複製保存しない。配送 tombstone には child Session ID、Delegation ID、terminal state、失効時刻、失効理由を残す。

## 共通操作

以下は Application Service が提供すべき概念操作である。名称と transport は後続設計で確定する。

```text
startChild(instruction, mentionText?, options, idempotencyKey) -> ChildHandle
getChildStatus(handle) -> ChildStatus
waitChild(handle, collectingParentRunId, timeout?, idempotencyKey) -> ChildResult | StillRunning
waitAny(handles, collectingParentRunId, timeout?, idempotencyKey) -> ChildResult | StillRunning
waitAll(handles, collectingParentRunId, timeout?, idempotencyKey) -> ChildResult[] | PartialResults
listChildResults(parentSessionId, filter?) -> ChildResultSummary[]
collectChildResult(handle, collectingParentRunId, idempotencyKey) -> ChildResult
cancelChild(handle, idempotencyKey) -> CancelResult
```

同期・並行・バックグラウンドは、呼び出し元 Agent がこれらを組み合わせて実現する。`startChild` に固定の同期・非同期モードを持たせる必要はない。

`instruction` は子 Agent が実行する具体的な依頼、`mentionText` は親 Agent の Character 口調で UI に表示する会話表現であり、別 field とする。mention text から実行 instruction を復元せず、instruction を Character 表現へ書き換えない。

## 複数子・再帰・同時実行上限

親 Session A は B、C など複数の child Session を起動できる。child Session B も同じ操作で C を起動できるため、親子関係は 1 階層に限定しない。cycle は拒否し、各子は直接の親と `orchestrationRootSessionId` を必ず持つ。

同時実行上限は `orchestrationRootSessionId` 単位で、その配下にある `executionState=running` の child Session 合計へ適用する。A が B と C を直接起動した場合も、A が B、B が C を起動した場合も同じ上限を共有する。上限に達した状態で `startChild` を呼んだ場合、Application Service は子 Session を作成せず、`capacity_exceeded` と現在値を含む retryable error を同期的に返す。初期版は待機 queue を持たない。

並行する複数の `startChild` で上限を超えないよう、root ごとの capacity check と slot reservation、子 Session / relation / Delegation / `queued` Run の作成を 1 つの admission transaction として直列化する。受理した子 Session はこの transaction で `executionState=running` に投影し、Provider 起動前から slot を消費する。

WithMate は再帰深度や作業範囲を固定 workflow として狭めない。ただし cycle、権限逸脱、上限超過など機械的に検証できる不正な起動は Application Service で拒否する。

## 実行パターン

### 1. 直ちに待機する

```text
parent running
  -> startChild
  -> waitChild
  -> parent waiting_child
  -> child terminal
  -> waitChild の tool result として結果を返す
  -> parent running
```

子の完了通知用 Message は作成しない。結果は待機中の操作への応答として親 Agent に返す。

`waiting_child` は親 Run の activity projection であり、terminal phase でも Session 状態でもない。タイムアウトは子の失敗とせず、`StillRunning` と `ChildHandle` を返す。呼び出し元 Agent は待機継続、別作業、キャンセル、またはバックグラウンド継続を選べる。

### 2. 同じ親 turn 内で並行実行する

```text
start child A
start child B
親側の処理を継続
waitAny / waitAll
結果を回収
親側の処理を継続
```

これは非同期に開始するが、親 turn 内に明示的な同期点を置く structured concurrency である。子の完了を親へ割り込ませず、呼び出し元 Agent が回収順序と待機位置を決める。

### 3. 親 turn をまたいで継続する

親 Run が terminal になった後も子を継続させる場合、呼び出し元 Agent は未回収結果が後続 turn に残ることを前提にする。

子が完了しても、WithMate は次の処理を自動実行しない。

- 親 Session への assistant / user Message 追加
- 実行中の親 Run への steer
- 親 Agent の新規 turn 開始
- 次の親 turn への結果全文注入

子の完了は `available` な配送結果として保持する。後続の親 Agent は一覧取得または明示的な `collect` によって必要な結果を回収する。

完了結果を親へ知らせるために、子から親へ途中 Message を送信したり、親 Run を完了まで無期限に保持したりしない。同期的に使いたい Agent は `waitChild` / `waitAny` / `waitAll` を選び、バックグラウンド継続を選んだ Agent は後続 turn で一覧・参照・`collect` を明示的に行う。

## Hook prompt と結果通知

アプリは Multi-Agent 操作を案内する Session / Run に対して Hook prompt を注入する。Hook prompt は少なくとも次を Agent へ伝える。

- 利用可能な子 Session 操作
- 同期・並行・バックグラウンドを目的に応じて選べること
- 子を開始した場合は `ChildHandle` を追跡すること
- 結果全文は自動配送されず、`wait` または `collect` が必要なこと
- 不要になった子を放置せず、状態確認またはキャンセルを検討すること
- 子が instruction を実行できるほど明確かを確認し、曖昧なら推測で進めず `clarification_required` を返せること
- 完了後、任意で instruction または成果の評価を CLI へ登録できること

Hook prompt は認可境界ではない。Application Service は各操作について capability grant、呼び出し元 Session / Run、親子相関、workspace、同時実行数などの制約を検証する。Agent が prompt を無視または誤解しても、許可されていない操作を実行できないようにする。

親 Run の開始時に未回収結果が存在する場合、アプリは動的な Hook metadata として通知する。結果本文や成果 summary は自動注入せず、全件取得には一覧・`collect` 操作を使う。

```text
未回収の子 Session 結果が 2 件あります。
- <child-session-id>: completed
- <child-session-id>: failed
```

Hook metadata は `totalCount` と、最大 20 件の child Session ID、Delegation ID、Session execution state、Delegation workflow status だけを含む。20 件を超える場合は `hasMore=true` を付け、残りを CLI で取得させる。順序は結果が回収可能になった日時の昇順とし、同じ未回収結果を毎 Run 通知しても Message や評価 record を作成しない。

UI notification と Agent context への注入は別の責務とする。UI は未回収結果を常時確認できるようにするが、UI が完了を通知しても親 Agent の会話 context を実行途中で変更しない。

## 指示の差し戻しと評価

子 Agent が instruction を曖昧と判断した場合、作業を推測で続けず、`clarification_required`、不足している情報、確認事項を ChildResult として即座に確定する。配送は通常の `wait` / `collect` contract を使い、評価登録の成否に依存しない。

評価は次の 2 系統を想定する。

- 子 Agent による instruction assessment: 指示の明確性、実行可能性など。
- 呼び出し元 Agent による outcome evaluation: 成果品質、選択された model / reasoning depth の適切性など。

どちらも Hook prompt で実施を促す soft control とし、未登録でも実行や結果回収を失敗させない。評価結果は専用の WithMate CLI write operation で DB に登録する。

初期 evaluation record は少なくとも次を保持する。

- evaluation ID と schema version
- kind: `instruction_assessment` / `outcome_evaluation`
- evaluator Session ID と evaluator role: `child` / `caller`
- Delegation ID、対象 child Session ID、対象 Run ID
- model、reasoning depth、任意の task category
- 1 から 5 の score と任意の bounded reason
- 作成日時

初期集計は、登録済み record の件数と、kind / model / reasoning depth / task category ごとの平均 score を返す。自動的な model 決定や高度な重み付けは行わず、呼び出し元 Agent が model 選定時に参照できる分析情報として提示する。将来の選定分析も、実際に登録された record だけを入力にする。

`clarification_required` は Delegation の制御フローであり、自動的な低評価ではない。差し戻し前の指示を暗黙に低評価として登録せず、評価 record が存在しない場合を 0 点や失敗として補完しない。

## Character、権限、model 選定

WithMate は利用可能な Character から child Session の Character をランダムに割り当てる。呼び出し元 Agent には「誰へ依頼するか」を選ばせず、割当結果を orchestration の判断材料として共有しない。UI は割り当てた Character の表示名を `@<Character>` の形式で mention text に付与し、複数 Character が一緒に作業している表現を作る。

初期版では Character 同士の関係性を delegation behavior に反映せず、割り当てた Character の通常の表示名だけを mention に使う。caller / callee Character の内部 matrix から mention の呼び名だけを変更する機能は初期 scope 外とする。将来導入しても、instruction、権限、model、reasoning depth、同期方法、親子構造には影響させない。

child Session の権限は親から与えられた capability の範囲を上限とし、子が親を超える権限を取得できない。個別の token / monetary budget は初期 scope で計測・強制しない。

Provider の種類は呼び出し元 Agent へ見せない。CLI / Hook は利用可能な model、各 model が対応する reasoning depth、特徴、過去の評価 record から得た分析結果を提示し、Agent が目的に応じて選択できるようにする。Provider 差分は WithMate の Adapter / Application Service で可能な限り吸収する。

## Session 参照、成果、file 変更

WithMate CLI は Session の検索、一覧、詳細、Message timeline、Run outcome、子 relation を ID から参照できるようにする。親へ返す標準結果は、ChildHandle / child Session ID、Delegation ID、terminal state、bounded summary を中心とし、必要な詳細は親 Agent が CLI で取得する。結果全文の無条件な親 context 注入は行わない。

file 変更の diff、競合検出、merge、commit ownership は WithMate の管理対象にしない。必要な確認は Git、workspace の仕組み、または各 Agent の手順に委ねる。WithMate は Agent の書き込み範囲を目的別に固定せず、同じ workspace への並行書き込みを理由に Multi-Agent を一律禁止しない。

## child Session の生存と Kill

親 Run が terminal になった場合や親 Session の lifecycle が閉じられた場合も、child Session を既定で cascade cancel しない。親 Run は子の完了確認を必須とせず終了でき、WithMate が追跡している child Session は原則として保持する。UI / CLI から一覧・状態確認・個別 Kill を行えるようにする。

Kill は cancel request であり、要求受理だけで `completed` や `canceled` を確定しない。Provider の応答、process 終了、または復旧判定によって Run と Session projection を `canceled` または `interrupted` に収束させる。cascade cancel を将来提供する場合も明示操作とし、既定では適用しない。

## 親への途中メッセージ送信との分離

Provider が実行中の追加メッセージ、steer、supplemental input をサポートしていても、子 Session の完了配送には使用しない。

途中メッセージは user または呼び出し元 Agent が明示的に親 Run の方針を変更する操作であり、子の terminal outcome を通知する transport ではない。この境界を混ぜると、次が競合する。

- Provider の streaming response
- 親 Run の tool call
- user の追加指示
- 複数の子 Session の同時完了
- cancel と terminal event

子の結果配送は `wait` / `collect`、親への方針変更は steer / supplemental input として別 contract にする。

## 不変条件

1. `startChild` は capacity slot、子 Session、親子 relation、Delegation、`queued` Run、idempotency key を Provider / 子 process の起動前に 1 つの admission transaction で永続化する。
2. 子が即時完了しても terminal outcome と配送結果を取りこぼさない。
3. 完了 event は child Run ID と terminal event ID で重複排除する。
4. `start`、`wait`、`collect`、`cancel` の再送は idempotency を保ち、同じ key には同じ ChildHandle または結果 envelope を返す。
5. 子の terminal outcome と親の terminal outcome を連動させない。
6. 親 Run が終了・失敗・キャンセルされても、明示的に cascade cancel されない限り子の outcome を推測しない。
7. 親への結果回収前に子 Session の Message を親 Session へ複製しない。
8. 1 件の子結果を複数回回収しても、親の会話履歴に重複 Message を作らない。
9. Provider 固有 Thread / Session ID を親子相関の正本にしない。
10. Session execution projection、Run phase、Delegation workflow、ResultDelivery state を 1 つの status field に統合しない。
11. `executionState=running` の child Session は `orchestrationRootSessionId` 単位の同時実行数へ 1 件として数える。
12. 子がさらに子を起動しても、全子孫は同じ `orchestrationRootSessionId` を継承する。
13. 指示の差し戻し、評価未登録、結果未回収を Provider 実行失敗へ変換しない。

## 競合と復旧

### 子の完了と親の終了

どちらが先でも、子の terminal outcome と配送状態を独立して確定する。親が先に終了した場合、子結果は `available` として後続 turn から回収できる。

### wait timeout と子の完了

timeout と terminal event が競合した場合、terminal outcome が確定済みなら結果を返す。未確定なら `StillRunning` を返し、直後に完了しても `available` な結果として回収できるようにする。

### cancel と terminal event

cancel request は terminal outcome ではない。Provider の terminal event または復旧判定によって最終 outcome を確定し、重複 terminal event を拒否する。

### user input と親の待機

親 Run が `waiting_child` の間に user input が届いても、子完了通知として親へ混在させない。入力を現在 Run の supplemental input とするか、次 Run へ待機させるか、中断するかは Session / Run contract と Provider capability に従う。

### process / app crash

起動時に `executionState=running` の child Session、親子 relation、non-terminal Run、Delegation、terminal outcome、配送状態を照合する。永続化済みの `queued` / `starting` Run は Provider 起動済みかを外部相関 ID と idempotency record から確認し、未起動なら安全に開始し、起動済みなら重複起動しない。Provider 側の外部実行が継続中であり、元 Run へ一意に再接続できることを証明できる場合は監視を再開する。未 dispatch、terminal outcome、継続可能な外部実行のいずれも証明できない Run だけを `interrupted` とする。

WithMate process、Provider process、transport のどこが crash したかにかかわらず、「Session projection が `running` だが terminal outcome を証明できない」同じ復旧分類として扱う。補正した Run から Session execution projection と配送状態を再構築し、Delegation は `result_available`、`clarification_required`、または診断可能な中断状態へ収束させる。永続化失敗は Provider 実行の失敗と区別する。

親へ見せる制御フローは共通化しても、Run outcome には `provider` / `transport` / `process` / `application` などの failure origin と redacted summary を残し、診断情報まで失わない。

## Persistence 境界

GitHub #283 の方針に従い、Main Process から同期的に SQLite を操作しない。Session execution projection、親子 relation、Delegation、RunEvent、terminal outcome、配送状態、評価 record の write は Persistence Worker / actor を経由する。

live UI の完了表示を SQLite commit 待ちにしない一方、親 turn をまたぐ未回収結果は再起動後にも発見できる必要がある。このため、実行状態と durability state を分離し、バックグラウンド結果を「復旧可能」と扱う条件は persistence 設計で明示する。

外部副作用を伴う `startChild` だけは、孤立した子 process を避けるため、子 Session、relation、Delegation、`queued` Run、idempotency record の durable commit を Provider 起動の前提にする。これは terminal outcome の live 表示を persistence commit 待ちにしない方針とは別の境界である。

## Auxiliary との境界

Auxiliary は、レビューやメイン context の切り離しを目的とした排他的な補助 Session である。Auxiliary の実行中は親 Session をブロックし、親と同じ workspace へ同時に変更が入ることを防ぐ。

Multi-Agent は呼び出し元 Agent が構成と待機方法を選ぶ orchestration 機能であり、Auxiliary の排他 policy を自動適用しない。両者は同じ Session / Run / Message contract を利用できるが、起動 policy と親への影響を別に定義する。

## 後続 scope

- Hook prompt の capability negotiation と Provider ごとの差異を transport 設計で具体化する。
- Character 間の呼称 matrix と設定 UI は、通常表示名だけでは表現力が不足した場合に検討する。
- evaluation record が十分に蓄積された後、task 特性、sample size、時間減衰などを考慮した model / reasoning depth の高度な選定分析を別設計で定める。
- Session 本体の retention / delete policy は persistence / privacy 設計で定める。ChildResultDelivery はその policy に従って `expired` へ遷移する。

## 検証 Gate

実装前に、少なくとも次を contract test の入力として具体化する。

- 子の即時完了と relation 作成の競合
- wait timeout 直前・直後の terminal event
- 複数子の同時完了と `waitAny` / `waitAll`
- `collect` の重複実行と再起動後の再取得
- `collected` 後も child Session が存在する限り再取得できること
- child Session 失効後に本文を複製せず配送 tombstone を返すこと
- 親終了後に完了した子の未回収結果
- 親 cancel と子 cancel の独立性 / cascade policy
- user input、親 wait、子完了の三者競合
- process crash 前後の terminal outcome と配送状態
- Session execution projection と Run phase の不整合 repair
- 直接の複数 child と入れ子 child が同じ root 上限を共有すること
- 上限到達時に child row や queue を作らず即時 error になること
- 同一 root への並行 `startChild` が capacity check をすり抜けないこと
- `clarification_required` と評価 record 未登録が独立していること
- Character のランダム割当が instruction や権限を変更しないこと
- 未回収 Hook metadata が最大 20 件で打ち切られ、結果本文を含まないこと
- 未登録評価を補完せず、登録済み record だけを集計すること
- unknown / duplicate / out-of-order Provider event
- 未回収 summary の bounded 性と結果本文の非自動注入
