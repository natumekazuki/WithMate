# Session / Run / Message Contract

- 作成日: 2026-07-10
- 対象: WithMate 新実装の会話、Provider 実行、表示履歴、実行 event
- 状態: 設計の基準
- 関連設計: `docs/design/provider-integration.md`, `docs/design/multi-agent-orchestration.md`

## 目的

Codex と GitHub Copilot の protocol 差分を WithMate の Application Service 内へ持ち込まず、CLI と将来の GUI が同じ会話履歴と実行状態を扱える共通 contract を定義する。

本書では domain 上の責務、不変条件、状態遷移、主要 use case を定める。DB table、process 構成、IPC / HTTP / JSON-RPC の具体的な型は後続設計で決める。

## 設計原則

1. Session は会話、Run は実行、Message は表示履歴を表し、互いの状態を兼用しない。
2. WithMate の Session / Message / Run event を共通履歴の正本にする。
3. Provider の Thread / Session / Turn / item ID は外部相関 ID として保持し、WithMate ID の代わりにしない。
4. streaming 中の assistant draft と完了後の assistant Message を分ける。
5. Provider の terminal event、user cancel、transport 切断、永続化失敗を同じ失敗へ潰さない。
6. UI を閉じても Application Service が生きている限り Run は継続できる。
7. 未知の Provider event は処理を停止させず、bounded / redacted な診断情報として残せるようにする。

## 概念モデル

```text
Session
├─ ProviderBinding
├─ Message 1..N
└─ Run 0..N
   ├─ initiating Message
   ├─ supplemental input Message 0..N
   ├─ RunEvent 1..N
   ├─ assistant draft / partial output
   └─ final assistant Message 0..1
```

### Session

ユーザーが継続して参照する 1 つの会話を表す。

責務:

- WithMate 内で安定した Session ID を持つ。
- Provider、workspace、既定の Character、作成日時、lifecycle 状態を保持する。
- Message の順序と Run の所属を定める。
- ProviderBinding を通して外部会話と対応する。
- CLI / GUI から同じ履歴を参照できるようにする。
- active / latest Run と整合する粗い実行状態を、一覧表示と crash recovery のために永続化する。

初期版では Session 作成後の Provider を変更しない。別 Provider へ引き継ぐ場合は、新しい Session を作成し、必要なら元 Session との relation と引き継いだ context を明示する。既存 Session の ProviderBinding だけを差し替える方式は、Provider 側履歴と WithMate 履歴の対応が不透明になるため採用しない。

Session は会話の利用可否を示す `lifecycleStatus` と、最新の論理実行を示す `executionState` を分けて永続化する。

| Field | Value | 意味 |
| --- | --- | --- |
| `lifecycleStatus` | `active` / `archived` / `closed` | 会話を継続利用できるか。実行結果とは独立する |
| `executionState` | `not_started` / `running` / `completed` / `failed` / `canceled` / `interrupted` | Session の最新 Run を一覧・検索・復旧向けに粗く表した永続 projection |
| `activeRunId` | Run ID / `null` | 現在 active な Run。`executionState=running` のとき必須 |
| `latestRunId` | Run ID / `null` | Session で最後に開始した Run |
| `executionStateUpdatedAt` | timestamp | projection の最終更新時刻 |
| `executionProjectionVersion` | integer | repair と競合検出に使う単調増加 version |

`executionState` は DB に保存するが、実行詳細の独立した正本にはしない。Run の phase / outcome と同じ Application Service transition で更新し、不整合時は Run から修復できる projection とする。`waiting_approval`、`waiting_input`、`waiting_child` などの一時的な待機理由は Session に保存せず、active Run の activity と pending operation から表示する。

`completed` は「Session が永久に終了した」ではなく「最新 Run が正常完了した」を意味する。同じ Session に後続 Run を開始すれば `running` へ遷移できる。会話を閉じる操作は `lifecycleStatus` で表す。

`lifecycleStatus` の遷移と write admission は次のとおりとする。

| Current | Operation | Next | Admission / rejection |
| --- | --- | --- | --- |
| `active` | archive | `archived` | active Run がなければ許可する。active Run がある場合は `session_busy` として拒否し、先に完了または cancel させる |
| `active` | close | `closed` | active Run がなければ許可する。active Run がある場合は `session_busy` として拒否する |
| `archived` | unarchive | `active` | retention 対象が残り、workspace / authorization と、存在する場合の ProviderBinding を再検証できる場合だけ許可する。Binding が未作成なら次 Run で作成可能かを検証する |
| `archived` | close | `closed` | 許可する |
| `closed` | unarchive / reopen | - | terminal lifecycle として拒否する。継続が必要なら新しい Session を作る |

新しい Run、user Message、approval / user input 応答、supplemental input の write は `lifecycleStatus=active` の Session だけが受理できる。`archived` は参照専用、`closed` は参照と retention / delete policy に従う後処理だけを許可する。archive / close と Run 開始が競合した場合は、同じ Session の admission を直列化し、先に durable commit した操作だけを成立させる。unarchive 後の最初の Run は通常の Run admission と同じ validation gate を通り、過去の `executionState` を実行許可の根拠にしない。

### ProviderBinding

WithMate Session と Provider 側の会話を対応付ける外部状態。

保持できる情報:

- Provider ID
- Codex Thread ID または Copilot ACP Session ID
- Provider CLI version
- protocol version / negotiated capability
- binding の作成・更新時刻
- resume 可否や最後に確認した外部状態

ProviderBinding が失効しても WithMate Session と Message は失われない。外部会話を再作成した場合は binding の履歴を診断可能にし、同じ外部 ID であったかのように上書きしない。

### Run

1 件の initiating user Message を起点に、Provider へ処理を依頼して terminal outcome を得るまでの論理実行を表す。

責務:

- WithMate 内で安定した Run ID を持つ。
- initiating Message と、実行中に追加された supplemental input Message を参照する。
- Run phase、activity、terminal outcome を持つ。
- Provider / model / reasoning / approval / sandbox / workspace / Character snapshot など、実行時設定の snapshot を保持する。
- Provider の Turn / request ID などを外部相関 ID として保持する。
- retry、internal attempt、cancel request を追跡できるようにする。
- RunEvent、途中出力、最終 assistant Message を関連付ける。

Run は詳細な実行状態と履歴の正本であり、Session の粗い `executionState` と同じものではない。1 Session に複数の過去 Run を保持し、別 Session の Run とは並行実行できる。

### Message

CLI / GUI の共通会話 timeline に表示する、WithMate が所有する会話単位。

初期 role:

| Role | 意味 |
| --- | --- |
| `user` | user が確定して送信した入力 |
| `assistant` | Provider 実行から確定した user-visible な最終応答 |

system prompt、developer instruction、Character prompt、tool / command event、approval、error notice は Message にしない。これらは Run execution snapshot、RunEvent、または Run outcome として扱う。

Message content は text だけに固定せず、将来の image、file、directory、mention などを表現できる content block の列として扱う。local path や secret をそのまま永続化するかは persistence / privacy 設計で決める。

Message は commit 後に本文を上書きしない。user が内容を編集して再送する場合は新しい Message と Run を作成する。

### RunEvent

Run 中に発生した normalized event を順序付きで表す。

初期 event category:

- Run 開始、状態変更、terminal outcome
- assistant draft 更新
- command / tool / file change の開始、更新、完了
- approval request と解決
- user input / elicitation request と解決
- usage / model / context telemetry
- Provider warning / error
- transport / process lifecycle
- unknown Provider event の診断 summary

RunEvent は append-only とし、WithMate が Run 内の単調増加 sequence を割り当てる。時刻だけを event 順序の正本にしない。

raw Provider payload は RunEvent の必須要素ではない。保存する場合も、secret、token、巨大本文、絶対 path を除去した bounded payload または外部 object への参照にする。

### Assistant draft / partial output

streaming delta を連結した実行中の仮出力。Message ではない。

- active Run の live projection として CLI / GUI へ配信できる。
- crash recovery や診断に必要なら snapshot を保存できる。
- Run が正常完了した場合は Provider の final item を優先して final assistant Message を確定する。
- failed / canceled / interrupted の partial output は診断用に保持してよいが、通常の assistant Message へ自動昇格させない。

これにより、途中で切れた文章や cancel notice が会話履歴へ assistant の発言として混ざることを防ぐ。

## 不変条件

### Session

- Session ID は WithMate が発行し、Provider ID と独立する。
- 初期版では 1 Session は 1 Provider に固定する。
- 初期版では 1 Session に active Run を 1 件だけ許可する。
- 複数 Session 間の Run は並行実行してよい。
- Message ordinal は Session 内で一意かつ単調増加とする。
- archive は参照・実行可否の policy であり、履歴削除を意味しない。
- `executionState=running` の Session は、その Session に属する `activeRunId` を 1 件だけ持つ。
- `activeRunId` と `latestRunId` は、必ず同じ Session に属する Run を参照する。
- Run phase と Session execution projection の更新は、同じ Application Service transition から persistence へ依頼する。
- projection が Run と矛盾する場合は Run を根拠に修復し、Session の値から Run outcome を推測しない。

### Run

- Run ID と Provider Turn / request ID を分離する。
- 新しい initiating user Message を作る場合は、片方だけが残らないよう Run と同じ admission transaction で受理する。exact retry は既存 Message への参照と新しい Run を同じ admission で受理し、Message を複製しない。
- active Run の実行設定は snapshot とし、Session の後続設定変更で書き換えない。
- terminal Run は再び active state へ戻さない。
- retry は新しい Run として作り、`retryOfRunId` で元 Run を参照する。
- transport 内部の再試行は同じ Run の attempt とし、user Message と Run を重複作成しない。
- user-visible な partial output、確定した command / file change、または未解決 approval がある場合、外部会話を捨てて無条件に内部再試行しない。
- `completed` への遷移と、存在する場合の final assistant Message の論理確定は同じ domain transition で行う。
- Provider 実行の terminal outcome と SQLite などへの durability state を分離し、永続化失敗によって確定済みの実行 outcome を `failed` へ変更しない。

### Message

- Provider の streaming chunk を直接 Message row として追加しない。
- Run が正常完了しても user-visible な最終本文が空なら、空の assistant Message を捏造しない。
- failed / canceled / interrupted の表示は Run outcome から投影し、system / assistant Message を自動追加しない。
- retry で同じ入力を再利用する場合、元の user Message を参照し、同じ本文の Message を自動複製しない。

### Event と相関

- RunEvent は Run ID を必須とし、Provider が提供する場合は外部 Thread / Turn / item / request ID も保持できる。
- 同じ Provider event の再受信に備え、外部 event ID または deterministic fingerprint で重複を検出できるようにする。
- unknown event は domain state を推測で変更せず、診断記録として扱う。

## Run phase と activity

Run の寿命と、active Run が現在何を待っているかを 1 つの enum に詰め込まない。

- `phase`: Run の lifecycle と terminal outcome を表す正本。
- `activity`: active phase 内の表示・操作用 projection。
- pending interaction: approval / user input request 本体。request ID ごとに独立して管理する。

### Run phase

| Run phase | 意味 |
| --- | --- |
| `queued` | user Message と Run を受理したが Provider へ未送信 |
| `starting` | Provider process、binding、外部会話、実行 request を準備中 |
| `active` | Provider 実行中。具体的な動作や待機理由は activity と pending interaction で表す |
| `canceling` | user cancel を受理し、Provider の terminal outcome を待機中 |
| `finalizing` | Provider の正常完了を受信し、terminal outcome と最終出力を論理確定中 |
| `completed` | Provider 実行が正常完了。final assistant Message がある場合は application state 上で確定済み |
| `failed` | Provider または Application Service が実行失敗を確定した |
| `canceled` | user cancel に対応する停止を確認した |
| `interrupted` | process 終了、接続切断、app crash などで terminal outcome を確定できない |

### Run activity

| Run activity | 意味 |
| --- | --- |
| `running` | 応答生成、reasoning、command / tool / file operation を実行中 |
| `waiting_approval` | 1 件以上の approval request が未解決 |
| `waiting_input` | 1 件以上の user input / elicitation request が未解決 |
| `waiting_child` | Multi-Agent の子 Session に対する明示的な wait 操作中 |

activity は `phase=active` のときだけ有効とする。複数種類の pending interaction または子待機が同時に存在する場合、それぞれの request / wait operation が正本であり、activity は CLI / GUI 用の代表表示にすぎない。代表表示の優先順位は `waiting_input`、`waiting_approval`、`waiting_child`、`running` とする。

### Durability state

Run phase と Message の論理確定とは別に、永続化の進行状況を追跡する。

| Durability state | 意味 |
| --- | --- |
| `pending` | application state 上で確定した変更が永続化待ち |
| `committing` | Persistence Worker / actor が書き込み中 |
| `committed` | 再起動後に復旧可能な状態まで永続化済み |
| `failed` | 永続化に失敗し、再試行または user-visible な警告が必要 |

`phase=completed` かつ `durabilityState=failed` は、Provider 実行後に生成された terminal outcome、assistant Message、RunEvent などの非 admission write に限って許可する。live UI / CLI の実行完了表示は SQLite commit を待たないが、未永続の状態を復旧可能とは表示しない。CLI / API は実行結果の `phase=completed` と、保存結果の `durabilityState=failed`、診断情報、再試行可否を同じ response envelope で別 field として返す。API の application status は `partial_success` とし、transport success のまま outcome と durability warning を返す。CLI は専用の非 0 exit code `durability_failed` と構造化出力の `overallStatus=partial_success` を返し、Provider の再実行ではなく persistence retry / status 確認へ誘導する。永続化失敗は Provider 実行失敗と別の診断・再試行対象にする。

一方、Run admission は外部副作用より前に durable commit が必要な境界である。initiating user Message、`queued` Run、Session execution projection、idempotency record、dispatch record のいずれかを永続化できない場合は Provider request を送らず、Run 開始自体を `admission_failed` として返す。この場合に `phase=completed` を返してはならない。

Provider dispatch の状態は durability state と分離し、Run attempt ごとに追跡する。

| Dispatch state | 意味 | 自動送信 |
| --- | --- | --- |
| `pending` | admission は committed、Provider 未送信を証明可能 | 許可 |
| `dispatching` | 送信 intent は committed、Provider の受理は未確定 | 新規送信は禁止。照会または Provider idempotency で収束させる |
| `accepted` | Provider の外部実行 ID と相関して受理済み | 禁止 |
| `rejected` | Provider が未受理を明示 | 同じ attempt では禁止 |
| `ambiguous` | 送信した可能性があるが受理を証明不能 | 自動再送は禁止 |

`pending -> dispatching` を durable commit してから送信する。transport 切断や process crash 後に受理を証明できなければ `ambiguous` とし、Provider の native idempotency または状態照会で同じ外部実行へ一意に収束できる場合だけ再接続する。同じ idempotency key と同じ request fingerprint の再送は既存 Run と dispatch outcome を返し、異なる fingerprint は conflict とする。実行をやり直す場合は別 Run と `retryOfRunId` を明示し、元の start request を再 dispatch しない。

### phase 遷移

```text
queued
├─> starting
└─> canceled

starting
├─> active
├─> canceling
├─> failed
└─> interrupted

active
├─> canceling
├─> finalizing ───────> completed
├─> failed
└─> interrupted

canceling
├─> canceled
├─> failed
└─> interrupted

finalizing
├─> completed
└─> failed
```

terminal phase は `completed`、`failed`、`canceled`、`interrupted` とする。

### terminal outcome

Run phase だけで原因を表現せず、少なくとも次を別 field として保持できるようにする。

- failure origin: `provider` / `transport` / `process` / `application` / `persistence` / `unknown`
- Provider error code と redacted summary
- cancel requested at / acknowledged at
- terminal event received at
- partial output の有無
- external side effect の有無または不明状態

Codex の `turn/completed(status=interrupted)` は、user cancel request と相関できた場合だけ `canceled` へ変換する。相関できない interruption は `interrupted` とする。Copilot ACP の対応は別環境検証後に確定する。

## 主要フロー

### Session 作成

1. Provider、workspace、Character、初期設定を検証する。
2. WithMate Session ID を発行する。
3. `lifecycleStatus=active`、`executionState=not_started` の Session を保存する。
4. ProviderBinding は最初の Run まで遅延作成してよい。

Provider 側会話の作成に失敗しても空の Session を保持するかは Application Service の option とする。初期 CLI は Session 作成と最初の Run を分離し、失敗の境界を明確にする。

### Run 開始

1. idempotency key、Session、active Run、入力、実行設定を検証する。
2. initiating user Message、`queued` Run、不変な Run execution snapshot、Session の `executionState=running` と `activeRunId` / `latestRunId`、idempotency record、未 dispatch の dispatch record を 1 つの admission transaction で受理する。
3. admission transaction の durable commit を待つ。失敗時は `admission_failed` を返し、Provider process の起動または request 送信へ進まない。
4. Provider process と ProviderBinding を準備し、`starting` へ遷移する。
5. durable な dispatch record を条件付きで `dispatching` へ更新してから Provider request を送り、外部 ID を相関させる。再送時は同じ idempotency / dispatch record を参照し、二重 dispatch を防ぐ。
6. Provider の開始 event を受けて `active` へ遷移し、activity を `running` とする。
7. event と assistant draft を順序付きで配信・記録する。
8. 正常完了を受けたら `finalizing` へ遷移する。
9. final assistant content がある場合は Message を作り、Run の `completed` と Session の `executionState=completed` / `activeRunId=null` を同じ domain transition で論理確定する。
10. admission 後に確定した Run、Message、RunEvent の永続化を Persistence Worker / actor へ依頼し、durability state を独立して更新する。

Run が `failed`、`canceled`、`interrupted` へ遷移する場合も、同じ domain transition で Session の `executionState` を対応する値へ投影し、`activeRunId` を解除する。

### 実行中の追加指示

- user が確定して送った追加指示は supplemental user Message として timeline に残す。
- 同じ active Run に関連付け、Message とは別の `RunInputDelivery` で Provider の steer / prompt request への配送を追跡する。user-visible な outcome は `pending` / `accepted` / `rejected` / `ambiguous` を区別し、送信 intent の内部状態として `dispatching` を持つ。attempt ID、idempotency key、Provider correlation ID、診断情報を保持する。
- Session が `active`、対象 Run が active かつ non-terminal、Provider capability が対応済みであることを再検証し、Message、RunInput、`pending` delivery attempt を 1 つの transaction で durable commit してから Provider へ送る。事前検証で拒否した入力は Message を作らない。
- `pending -> dispatching` を durable commit してから Provider へ送る。復旧時に安全に自動送信できるのは `pending` だけとし、`dispatching` のまま受理を証明できない attempt は `ambiguous` へ収束させる。
- supplemental user Message は送信後に書き換えない。`rejected` 後の修正は新しい Message として記録し、同じ idempotency key の再送だけが同じ delivery attempt / outcome を返す。
- timeout や transport 切断で Provider が受理したか証明できない場合は `ambiguous` とし、自動再送しない。user または Agent が明示的に再送する場合も、元 Message と delivery attempt を参照して重複の可能性を表示する。
- Provider が steering を提供しない場合、暗黙に新しい Run へ変換しない。queueing、拒否、新 Run 作成のどれを採るかを capability に基づき明示する。
- `pending` / `rejected` / `ambiguous` の supplemental Message を、active Run の終了後に後続 Run の initiating Message として暗黙に転用しない。新しい Run に渡す場合は明示操作で新しい initiating Message と Run admission を作る。

### Approval / user input

1. Provider request を外部 request ID と Run ID で相関する。
2. unresolved request を保存し、Run activity を `waiting_approval` または `waiting_input` へ投影する。
3. CLI / GUI の回答に idempotency key を要求する。
4. Provider response が解決済みであることを確認する。
5. unresolved request がなくなれば activity を `running` へ戻す。

複数 pending request が発生した場合に備え、Run activity だけで request 本体を表現しない。

### Cancel

1. terminal Run への cancel は状態を変更せず、既に完了していることを返す。
2. active Run への cancel request を記録し、`canceling` へ遷移する。
3. Provider へ interrupt / cancel を送る。
4. user cancel と相関する terminal outcome を確認したら `canceled` とする。
5. timeout、process 終了、相関不能なら `interrupted` とする。

partial assistant output は診断用に保持できるが、assistant Message へ自動追加しない。

### Retry

- 同じ user Message を再実行する場合、新しい Run を作り `retryOfRunId` を設定する。
- user が本文や添付を変更した場合、新しい user Message と Run を作る。
- stale ProviderBinding に対する narrow な internal retry は、meaningful partial や確定 side effect がない場合に限り、同じ Run 内の新しい attempt として実行できる。
- retry の上限と classifier は Provider Adapter ごとに明示し、一般的な error 全体へ広げない。

### process / app crash 後の復旧

1. 起動時に `executionState=running` の Session と non-terminal Run を列挙し、`activeRunId` と所属を照合する。
2. 永続化済みの `queued` / `starting` Run が Provider へ未 dispatch であることを idempotency record と外部相関 ID から証明できる場合は、安全に開始する。dispatch 済みか不明な Run を重複起動しない。
3. Provider が terminal outcome と最終出力を一意に再照会できる場合だけ、元 Run を `finalizing` から確定させる。
4. 未 dispatch、terminal outcome、継続可能な外部実行のいずれも証明できない Run は `interrupted` とする。
5. 確定または補正した Run phase に合わせ、Session の `executionState`、`activeRunId`、`latestRunId` を修復する。
6. interrupted notice を assistant / system Message として追加しない。
7. user は元 user Message を参照した retry Run を開始できる。

Provider resume は会話継続の仕組みであり、未完了 Run の成功を推測する仕組みではない。

## CLI から必要な Application Service 操作

command 名は後続 CLI 設計で確定する。Application Service は少なくとも次を提供する。

### Session

- Session 作成
- Session 一覧・詳細・Message timeline・永続 execution state 取得
- Session archive / unarchive
- linked Session 作成

### Run

- Run 開始
- Run phase・activity・結果取得
- RunEvent の cursor 付き取得 / follow
- cancel
- retry
- approval 回答
- user input / elicitation 回答

### Linked Session / Multi-Agent

- 親子 relation、Delegation、`orchestrationRootSessionId` を条件にした Session 検索
- child Session 一覧、永続 execution state、詳細、Run outcome の取得
- child Session の開始、待機、結果一覧、結果回収、cancel / Kill
- instruction assessment と outcome evaluation の任意登録
- 登録済み評価 record だけを対象にした集計・分析取得

write operation は idempotency key を受け取り、同じ request の再送で Message、Run、回答を重複作成しない。

## Linked Session / Multi-Agent / Auxiliary との関係

Multi-Agent で作成する子 Session は、通常と同じ contract を使う独立 Session とする。通常 Session と Multi-Agent 専用 Session を型や mode で区別せず、親 Session、起動元 Run、子 Session の relation によって相関させる。子の役割や目的を示すラベルは、WithMate の実行挙動を切り替える Session 種別として扱わない。

同期、同一 turn 内の並行実行、親 turn をまたぐ継続は、呼び出し元 Agent が `wait` / `collect` などの共通操作を組み合わせて選択する。子の完了結果を実行中の親へ unsolicited Message として挿入しない。詳細は `docs/design/multi-agent-orchestration.md` を正本とする。

未回収結果がある場合は、後続の親 Run 開始時に ID と状態だけの bounded Hook metadata を投影する。結果本文は自動注入せず、child Session が参照可能な間は CLI から再取得できる。

親 Run の終了や親 Session の close による child Session の cascade cancel は既定で行わない。child Session の cancel / Kill は明示操作とする。

Auxiliary も Session / Run / Message の共通 contract を使うが、Multi-Agent とは別の起動 policy を持つ。Auxiliary の実行中は親 Session をブロックする。Auxiliary の context 引き継ぎ、既定動作、排他範囲は後続の Auxiliary 設計で確定する。

## 旧実装から引き継ぐ考え方

- 実行の owner を window / renderer に置かない。
- Session timeline の final Message、実行中の interim、Provider output を分ける。
- failed / canceled の partial output と Provider trace を捨てない。
- narrow な stale binding recovery は同じ論理実行内で 1 回だけ再試行できる。
- Provider 固有 event を Adapter で normalized event へ変換する。

## 旧実装から引き継がないもの

- Session の単一 `runState` だけで会話 lifecycle、待機理由、実行 outcome を兼用する設計。
- cancel / interrupted notice を assistant Message として自動追加する設計。
- Provider SDK の object lifecycle を domain model に直接露出する設計。
- 旧 DB schema、message sequence の再作成方式、migration compatibility。
- UI の Details / right pane 分類を永続化 model へ直結させる設計。

## 未決事項

- CLI process 終了後も Run を継続する daemon / local service の process model。
- RunEvent と assistant draft の保存頻度、retention、object storage 境界。
- image / file / directory content block の永続表現と privacy policy。
- linked Session へ渡す history、summary、Character snapshot の範囲。
- Session 削除と Provider 側 Thread / Session 削除を連動させるか。
- Copilot ACP の resume、cancel、steer、permission、並行実行から確定する状態 mapping。
- Codex の persistent Thread resume、interrupt、steer、approval / elicitation から確定する recovery mapping。
- 将来 1 Session に複数 active Run を許可する場合の branch / merge contract。

## 検証 Gate

次の設計へ進む前に、実装ではなく contract test の入力として以下を具体化する。

- state transition の許可 / 拒否表
- lifecycle archive / close と Run / Message write admission の競合
- Run admission の durable commit 失敗時に Provider dispatch しないこと
- dispatch record の再送で Provider request を重複させないこと
- idempotency key の重複 request
- streaming delta と final item の不一致
- final output なしの正常完了
- cancel と terminal event の競合
- approval 回答と cancel の競合
- non-terminal Run の起動時補正
- unknown / duplicate / out-of-order Provider event
- supplemental input の accepted / rejected / ambiguous と冪等再送
- ambiguous supplemental input を後続 Run へ暗黙に転用しないこと

Provider 固有の runtime 検証結果が本書の不変条件と矛盾した場合は、Adapter の回避処理を先に検討する。共通 contract を変更する必要がある場合は、Codex と Copilot の両方への影響を確認してから更新する。

## 参照

- `docs/design/provider-integration.md`
- `docs/investigations/codex-app-server/capability-matrix.md`
- `docs/investigations/codex-app-server/validation-results.md`
- `docs/investigations/github-copilot-acp/validation-plan.md`
- `old/docs/design/session-run-lifecycle.md`
- `old/docs/design/session-turn-storage-v6.md`
- `old/docs/design/provider-adapter.md`
