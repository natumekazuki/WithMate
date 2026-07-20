# Codex App Server Adapter Contract

- 作成日: 2026-07-11
- 対象: WithMate 新実装の Codex App Server Adapter
- 状態: 設計の基準（CP3 runtime contract確定済み、interaction詳細は一部未検証）
- 調査対象 version: `codex-cli 0.144.6`（persistent Thread復旧の既存実測は`0.144.1`）
- 関連設計: `docs/design/provider-integration.md`, `docs/design/session-run-message-contract.md`, `docs/design/multi-agent-persistence.md`
- 検証資料: `docs/investigations/codex-app-server/capability-matrix.md`, `docs/investigations/codex-app-server/validation-plan.md`, `docs/investigations/codex-app-server/validation-results.md`

## 目的

Codex App Server の request、notification、server request、Thread / Turn / item を WithMate の ProviderBinding、Run、Message、RunEvent、RunOutputItem、実行中の live interaction へ変換する契約を定める。

App Server 固有の ID、status、item type を Application Service や GUI へ直接公開しない。WithMate の共通契約と矛盾する Provider 差分は本 Adapter 内で変換し、変換できない場合は推測で状態を進めず診断可能な形で残す。

## 根拠の区分

| 区分 | 意味 | 扱い |
| --- | --- | --- |
| 実測済み | 対象Codex CLIで通信順序とsanitizedな結果を確認した | 対象versionを併記して初期実装の基準にできる |
| schema 確認 | stable 生成 schema で型・method を確認したが runtime 未検証 | 契約 test を必須とする |
| 暫定変換 | WithMate の不変条件を保つための Adapter 方針 | runtime 検証後に確定または修正する |
| 対象外 | experimental schema だけの機能または初期 scope 外 | 必須依存にしない |

起動時に実際の Codex CLI version と交渉結果を Provider process / 接続環境の診断へ記録する。ProviderBinding や RunAttempt には混在させない。本書の version と異なる場合は、生成 schema と契約 test を実行せずに互換とみなさない。

## 接続と初期化

### process / transport

- 長寿命WithMate runtime hostが`codex app-server`をstdio child processとして起動し、接続終了まで所有する。CLIやRendererはApp Serverへ直接接続しない。
- 初期 transport は stdio 上の 1 行 1 JSON message とする。
- stdout は protocol 専用、stderr は bounded / redacted な診断用とする。
- wire envelope は JSON-RPC 2.0 に近いが、実測で `jsonrpc` field が無い。一般的な JSON-RPC library を使う場合はこの形式を許容する。
- WebSocket、Codex managed daemon、experimental APIは初期実装の必須機能にしない。runtime hostとCLI / GUIのlocal IPCはApp Server transportと分離し、ADR 013に従う。

### handshake

1. process 起動後に `initialize` request を送る。
2. initialize response を検証する。
3. `initialized` notification を送る。
4. 初期化完了前に Thread / Turn operation を送らない。
5. CLI version、protocol / capability、初期化時の feature 情報を記録する。

initialize 失敗は Provider 接続失敗であり、WithMate Session や受理前の Run を Provider 実行失敗として作成しない。受理済み Run の dispatch 中に失敗した場合は Run attempt / dispatch 契約で別に収束させる。

## ID と所有権

| Codex ID | WithMate の保持先 | 用途 |
| --- | --- | --- |
| Thread ID | ProviderBinding / binding history | WithMate Session と Codex 会話の外部相関 |
| Turn ID | RunAttempt | WithMate Run と Codex 実行の外部相関 |
| item ID | RunEvent / RunOutputItem の外部相関 | delta、started、completed、重複 event の照合 |
| server request ID | live interaction | 実行中だけ保持する approval / elicitation 回答と解決の相関 |

Codex ID を WithMate の primary key にしない。Thread / Turn / item が取得できない場合でも、WithMate Session / Run / Message は参照可能なまま保つ。

## Thread 契約

### 新規作成

- `thread/start`を送る前に、対象Session / RunAttemptと相関する`creating` ProviderBinding intentをdurable commitする。
- `thread/start`の成功responseと`thread/started` notificationはThread IDで相関し、同じtransactionでBindingへThread IDを設定して`active`へ進め、作成元RunAttemptの`provider_binding_id`も設定する。BindingとAttemptのSession所属一致をcommit前に検証する。
- response loss、timeout、process crashで作成受理が不明な場合、同じ`thread/start`を自動再送しない。Thread list / readまたはProvider native idempotencyで同一Threadを一意に証明できた場合だけ元Bindingをactive化する。
- 一意照合できなければBindingを`invalidated(conversation_start_ambiguous)`、Runを`interrupted`へ収束させる。相関不能なorphan Threadは診断対象として許容し、推測相関や自動削除を行わない。
- ProviderBinding は Thread ID、ephemeral / persistent mode、作成intentと状態、作成時刻を保持する。
- 同じ WithMate Session に異なる Thread ID を関連付け直す場合は旧 binding を履歴として残し、上書きしない。

### 読取・再開

- `thread/read` は照合・復旧補助に使う。WithMate の Message / RunEvent を全面的に再構築する入力にしない。
- ephemeral Threadの`thread/read(includeTurns=true)`は`codex-cli 0.144.1`で拒否された。ephemeral Threadを履歴復旧の根拠にしない。
- completed persistent Threadは、App Server process再起動後に`thread/read(includeTurns=true)`で履歴を取得し、`thread/resume`で`idle`へ再開できることを`codex-cli 0.144.1`で確認した。
- stdio App Server processをactive Turn中に終了すると、再起動後の`thread/resume`では同じTurnが`interrupted`となる。同じTurnの実行継続や欠落eventの再配信を前提にしない。
- `thread/status/changed(idle)` だけで Run の正常完了を確定しない。

## Turn / Run lifecycle

| Codex Turn status | WithMate Run phase | 判定 |
| --- | --- | --- |
| `inProgress` | `active` | 実測済み。live activityはitem / live interactionから投影する |
| `completed` | `completed` | `turn/completed` で正常完了を確定する |
| `failed` | `failed` | failure origin と redacted summary を別に保持する |
| `interrupted` | `canceled` または `interrupted` | user cancel と相関できた場合だけ `canceled`。それ以外は `interrupted` |

### Run 開始

1. WithMateのRun admission、dispatch intent、必要な`creating` Binding intentをdurable commitする。
2. active Bindingがなければ前項の規則で`thread/start`を送り、Bindingのactive化をcommitする。受理不明のまま`turn/start`へ進まない。
3. dispatch record を `dispatching` へ durable update する。
4. `turn/start` を送る。
5. response / `turn/started` の Turn ID を RunAttempt と相関する。
6. `inProgress`を確認し、Runを`active`、runtime hostのlive activityを`running`へ投影する。

`thread/status/changed(active)` だけで Turn 開始成功を確定しない。Turn ID を相関できない event で Run を進めない。

### Run 完了

- `turn/completed` の status を terminal outcome の根拠にする。
- `thread/status/changed(idle)` は観測値であり、正常完了の根拠にしない。
- `completed` で final assistant candidate がある場合だけ final Message を作成する。空の final Message は作らない。
- `failed` / `interrupted` の assistant output は partial / assistant detail として保持できるが、final Message へ昇格させない。
- terminal 更新と final Message の論理確定は `docs/design/session-run-message-contract.md` の同一 domain transition 規則に従う。

## item lifecycle と順序

### 共通処理

- `item/started` で item ID、Turn ID、item type を登録する。
- delta notification は item ID で相関し、item 内の受信順に連結する。
- `item/completed` の確定 item を delta 連結結果より優先する。不一致は診断 event として残す。
- Provider 時刻を順序の基準にせず、WithMate が Run 内の単調増加 sequence を割り当てる。
- 同じ item event の再受信は external event ID または deterministic fingerprint で重複排除する。
- completed 後の未知 delta、item/started より先に届いた delta、別 Turn の item は domain state を進めず、bounded な診断対象とする。

## assistant message 分類

`codex-cli 0.144.6`のstable生成schemaでagentMessage itemは`phase`を持ち、値は`commentary` / `final_answer` / `null`である。schemaはProviderがphaseを一貫して返すとは限らず、`null`をphase unknownとして互換処理するよう求めている。隔離probeを2回実行し、各回で`commentary` 1件、`final_answer` 1件、`null` 0件を観測した。

| App Server item | WithMate 変換 | 状態 |
| --- | --- | --- |
| `agentMessage.phase='commentary'` | RunOutputItem `category='assistant_detail'` | runtime実測済み |
| `agentMessage.phase='final_answer'` | final assistant candidate | runtime実測済み。Turn成功完了までMessageとして確定しない |
| `agentMessage.phase=null` | phase unknown item | stable schema確認。runtimeでは未観測。受信時点でfinalと断定しない |

### final Message の確定

1. agentMessage delta を item ID ごとに draft として構築する。
2. `item/completed` で item text と phase を確定する。
3. `commentary` は assistant detail として保存する。
4. `final_answer` は final candidate として保持する。複数ある場合は item 境界を content block 境界として保ち、1 Message へまとめる。
5. `turn/completed(status='completed')` で final candidate を final assistant Message 0..1 として確定する。
6. Turn がそれ以外の terminal status なら final Message を作成せず、candidate を assistant detail / partial output として保持する。

### `phase=null` fallback（暫定）

successful Turn に明示的な `final_answer` が無い場合のみ、次の互換処理候補を使う。

1. completed 済みの非空 `phase=null` agentMessage を Run sequence 順に並べる。
2. 最後の 1 item を final candidate とする。
3. それ以前の phase unknown item は `assistant_detail` として保持する。
4. fallback を使用したことと、対象 CLI version / model を診断可能に記録する。

この fallback は runtime 契約 test で「phase なしの複数 agentMessage が 1 つの final response を構成する」ことが確認された場合に見直す。不明な item 全件を無条件に final Message へ連結しない。

## tool / command / file / reasoning 変換

| App Server item / event | WithMate 変換 | 通常 hydrate |
| --- | --- | --- |
| command execution | RunOutputItem `operation` + RunEvent | count のみ |
| file change | RunOutputItem `operation` + RunEvent | count のみ |
| tool / MCP call | RunOutputItem `operation` + RunEvent | count のみ |
| reasoning / plan / progress | RunOutputItem `assistant_detail` または `diagnostic` | 読み込まない |
| usage / context | RunOutputItem `telemetry` | 読み込まない |
| warning / error | RunOutputItem `diagnostic` + 必要な Run outcome summary | bounded summary のみ |
| 未知 item / event | RunOutputItem `provider_metadata` + RunEvent | 読み込まない |

RunOutputItem は item ごとの bounded summary と詳細 payload 参照を分ける。stdout / stderr、diff、raw payload を summary と同じ JSON に入れない。Session の通常 hydrate は final Message だけを読み、RunOutputItem を join しない。

## approval / elicitation / user input

| Server request | WithMate 変換 |
| --- | --- |
| `item/commandExecution/requestApproval` | pending approval |
| `item/fileChange/requestApproval` | pending approval |
| `item/permissions/requestApproval` | permission 種別を保った pending approval |
| `item/tool/requestUserInput` | pending user input |
| `mcpServer/elicitation/request` | Provider payload を保った pending elicitation |
| `serverRequest/resolved` | 対象 request の解決確認 |

- server request ID を live interaction の外部相関 ID とし、実行中の Application Service メモリだけに保持する。
- request bodyと回答をlive activityへ埋め込まない。live activityは`waiting_approval` / `waiting_input`の代表表示だけとし、DBへ保存しない。
- 回答 operation は idempotency key を受け、解決済み request への二重回答を送らない。
- 解決後の事実はRunEvent、必要なbounded summaryはRunOutputItemに保存する。runtime hostまたはApp Server processの再起動後は、保存済み履歴だけから未解決requestを回答可能な状態へ復元しない。
- allow / deny / timeout / duplicate response / process 切断の runtime 順序は未検証。本書の state mapping は契約 test 完了後に確定する。

## steer / interrupt

### steer

- `turn/steer` は `expectedTurnId` と active Run の外部 Turn ID が一致する場合だけ送る。
- `codex-cli 0.144.6`では不一致`expectedTurnId`とactive Turn不在を`-32600`で拒否し、一致時は同じTurn IDを返してsupplemental user Messageを同一Turn履歴へ反映した。
- supplemental Message の Provider 配送結果は accepted / rejected / ambiguous を区別する。
- 不一致、timeout、切断時に supplemental Message を後続 Run へ暗黙転用しない。
- public operationは`withmate run send-input`とし、Provider method名をCLI contractへ漏らさない。

### interrupt

- user cancel を durable に受理し、Run を `canceling` にしてから `turn/interrupt` を送る。
- `codex-cli 0.144.6`では空response、`thread/status/changed(idle)`、`turn/completed(interrupted)`の順を2回観測した。request成功だけでRunを`canceled`にしない。
- `turn/completed(status='interrupted')` を user cancel request と相関できた場合だけ `canceled` にする。
- timeout、process 終了、相関不能は `interrupted` に収束させる。
- public operationは`withmate run cancel`とし、Provider method名をCLI contractへ漏らさない。

## 切断・再起動・復旧

1. durable な dispatch state と外部 Thread / Turn ID を読み込む。
2. `pending` で Provider 未送信を証明できる場合だけ送信を開始する。
3. `dispatching` 以降で受理を証明できない場合は自動再送しない。
4. persistent Thread / Turnへ一意に再接続でき、resume結果が同じTurnの`inProgress`を示す場合だけ監視を再開する。stdio App Server process異常終了後は`codex-cli 0.144.1`で`interrupted`となるため監視を再開しない。
5. Provider 未送信、terminal outcome、継続可能な外部実行のどれも証明できない Run は `interrupted` にする。

`thread/read`の履歴は照合補助であり、欠落したRunEventやMessageを推測で自動生成しない。切断前に受信済みの未確定assistant deltaがpersistent Turn履歴へ残らないことを確認している。streaming deltaを永続化しない共通方針に従い、crash時の未確定draft消失を許容し、復旧時にpartial outputを推測生成しない。

WindowsではCodex managed daemon lifecycleが非対応のため、CAS-017は`blocked`である。初期構成はdaemonへ再接続せず、WithMate runtime hostがstdio connectionを保持する。CLI disconnectはruntime hostへのlocal IPCだけを閉じ、App Server connection、live Run、draft、interactionを終了しない。runtime host crash時は前記のProvider照合規則へ進む。

## unknown / duplicate / out-of-order event

- 未知 notification / item type で client loop を停止しない。
- 未知 event は Provider、method / item type、Thread / Turn / item ID、bounded summary、redaction 有無だけを軽量診断に残す。
- raw payload が必要な場合は secret、token、account 情報、絶対 path、巨大本文を除去し、RunOutputItem `provider_metadata` の遅延読み込み payload にする。
- duplicate / out-of-order event で Run phase、Message、live interaction を重複更新しない。
- terminal Run に届いた未知 event で Run を non-terminal へ戻さない。

## model / capability

- `model/list` を cursor / limit で全 page 取得し、model ID、表示名、reasoning effort、入力 modality などを WithMate の capability model へ変換する。
- catalog は CLI version / account で変動するため、ハードコードしない。
- hidden model は通常の選択肢に自動追加しない。
- `modelProvider/capabilities/read` は schema 確認のみ。version 差分を検証する。
- orchestration API は Provider 名を Agent へ露出せず、WithMate の model / reasoning / feature 表現へ変換する。

## 初期実装で必要な Adapter operation

```text
initialize
listModels
startThread
resumeThread
readThread
startTurn
steerTurn
interruptTurn
respondToApproval
respondToUserInput
respondToElicitation
close
```

`resumeThread`、`steerTurn`、`interruptTurn`は対象versionのruntime evidenceとcontract testをGateに利用可能とする。approval / input / elicitation responseはruntime検証完了までcapabilityとして条件付きにし、schemaにmethodが存在することだけで安全に利用可能と公開しない。

## 契約 test matrix

### 基本通信

- initialize / initialized 前の operation 拒否
- `jsonrpc` field が無い wire envelope
- model pagination と version 差分
- Thread / Turn / item ID の相関
- 同一 process 上の複数 Thread event 分離

### assistant / output

- `commentary` と `final_answer` の分離
- `phase=null` が 1 件 / 複数ある場合の fallback
- delta と completed item の不一致
- item boundary を保った final Message の content block 生成
- final candidate 後の failed / interrupted Turn
- assistant detail と tool payload を通常 Session hydrate が読まないこと

### interaction / lifecycle

- approval allow / deny / timeout / duplicate answer
- user input / MCP elicitation 回答
- steer の `expectedTurnId` 一致 / 不一致
- interrupt と natural completion の競合
- App Server crash / client crash / stdin close
- runtime host IPCのclient-only切断、response loss、snapshot / cursor再接続、欠落event
- unknown / duplicate / out-of-order notification

## 未検証事項と実装 Gate

| 項目 | 現在 | Gate |
| --- | --- | --- |
| persistent Thread resume / read | completed Turnとstdio process異常終了を実測済み | runtime host crashのprocess testで照合と`interrupted`収束を確認 |
| `agentMessage.phase`のruntime一貫性 | explicit commentary / finalを実測済み | final Message mapperの契約test |
| `phase=null` fallback | stable schema確認、runtime未観測 | 1件 / 複数unknown itemのmapper契約test |
| interrupt | responseからterminalまで実測済み | durable cancelとの相関と競合のcontract test |
| steer | 一致 / 不一致 / terminal後と履歴を実測済み | accepted / rejected / ambiguous deliveryのcontract test |
| approval / input / elicitation | schema 確認のみ | timeout、duplicate、切断を検証 |
| 複数 Thread 並行実行 | 未実施 | event 相関と process 上限を検証 |
| unknown notification | 未実施 | Adapter client の契約 test を実施 |

未検証機能は、実装時に黙って使うのではなく capability unavailable または明示的な制限として公開する。

## 参照

- `docs/design/provider-integration.md`
- `docs/design/session-run-message-contract.md`
- `docs/design/multi-agent-persistence.md`
- `docs/adr/013-runtime-host-and-run-mutation-control-plane.md`
- `docs/investigations/codex-app-server/capability-matrix.md`
- `docs/investigations/codex-app-server/validation-plan.md`
- `docs/investigations/codex-app-server/validation-results.md`
- `docs/investigations/codex-app-server/runtime-contract-probe.mjs`
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
