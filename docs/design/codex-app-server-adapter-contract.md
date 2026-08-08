# Codex App Server Adapter Contract

- 作成日: 2026-07-11
- 対象: WithMate 新実装の Codex App Server Adapter
- 状態: 設計の基準（CAS-001〜CAS-016完了。interactionの主要経路・競合・stdio切断・最大同時active数10を実測済み。CAS-017はWindowsでblocked）
- 生成schema baseline: `codex-cli 0.145.0` stable（interaction runtimeは`0.145.0`と`0.146.0`、既存runtime contractは`0.144.6`、persistent Thread復旧の既存実測は`0.144.1`）
- 関連設計: `docs/design/provider-integration.md`, `docs/design/session-run-message-contract.md`, `docs/design/multi-agent-persistence.md`
- 検証資料: `docs/investigations/codex-app-server/capability-matrix.md`, `docs/investigations/codex-app-server/validation-plan.md`, `docs/investigations/codex-app-server/validation-results.md`

## 目的

Codex App Server の request、notification、server request、Thread / Turn / item を WithMate の ProviderBinding、Run、Message、RunEvent、RunOutputItem、実行中の live interaction へ変換する契約を定める。

App Server 固有の ID、status、item type を Application Service や GUI へ直接公開しない。WithMate の共通契約と矛盾する Provider 差分は本 Adapter 内で変換し、変換できない場合は推測で状態を進めず診断可能な形で残す。

## 根拠の区分

| 区分        | 意味                                                        | 扱い                                        |
| ----------- | ----------------------------------------------------------- | ------------------------------------------- |
| 実測済み    | 対象Codex CLIで通信順序とsanitizedな結果を確認した          | 対象versionを併記して初期実装の基準にできる |
| schema 確認 | stable 生成 schema で型・method を確認したが runtime 未検証 | 契約 test を必須とする                      |
| 暫定変換    | WithMate の不変条件を保つための Adapter 方針                | runtime 検証後に確定または修正する          |
| 対象外      | experimental schema だけの機能または初期 scope 外           | 必須依存にしない                            |

起動時に実際の Codex CLI identity と交渉結果を Provider process / 接続環境の診断へ記録する。ProviderBinding や RunAttempt、Provider definition versionには混在させない。生成schemaのversionはDecoderと契約testを更新するためのevidenceであり、production runtimeのadmission gateにはしない。

production runtimeは`initialize` responseの`userAgent`をboundedな接続診断として記録し、CLI releaseのallowlistまたはSemVer rangeでは拒否しない。実際のstable protocol response、notification、server requestをAdapterのDecoderへ通し、未知の加算fieldはcanonical projectionから除外する。必須field欠落、既知field不正、既知variant競合、resource limit違反、未知request methodは、operation errorまたはconnection failureとして診断可能かつ単調な終端へ収束させる。WithMate public settings、interaction snapshot、responseのexact validationは緩めない。

## 接続と初期化

### process / transport

- 長寿命WithMate runtime hostが`codex app-server`をstdio child processとして起動し、接続終了まで所有する。CLIやRendererはApp Serverへ直接接続しない。
- 初期 transport は stdio 上の 1 行 1 JSON message とする。
- stdout は protocol 専用、stderr は bounded / redacted な診断用とする。
- wire envelope は JSON-RPC 2.0 に近いが、実測で `jsonrpc` field が無い。一般的な JSON-RPC library を使う場合はこの形式を許容する。
- `turn/start`と`turn/steer`のtext inputはMessageの共有契約であるUTF-8 JSON 4 MiB / 10,000 blockをAdapterでも維持する。`turn/start`はSessionが受理したworkspace pathとadditional directoriesも同時に運ぶため、Adapter aggregate、transport line、queued writeはMessage、directory scope、JSON escape、App Serverの`text_elements`とwire envelopeから共有定数で導出する。queued writeは最大frame 2件分を保持し、runtime IPC / CLIの64 KiB / 4,096 block上限とは混同しない。
- Workspace pathは共有のcanonical host pathと32,768文字上限を使う。短い識別子向けのUTF-8 byte上限をWorkspace pathへ適用しない。
- WebSocket、Codex managed daemon、experimental APIは初期実装の必須機能にしない。runtime hostとCLI / GUIのlocal IPCはApp Server transportと分離し、ADR 013に従う。

### handshake

1. process 起動後に `initialize` request を送る。
2. initialize response を検証する。
3. `initialized` notification を送る。
4. 初期化完了前に Thread / Turn operation を送らない。
5. CLI version、protocol / capability、初期化時の feature 情報を記録する。
6. `modelProvider/capabilities/read`とhiddenを含む`model/list`全pageを読み、Provider definitionが要求するmodel / reasoning tupleとfeature capabilityを検証してからThread / Turn operationを許可する。

initialize 失敗は Provider 接続失敗であり、WithMate Session や受理前の Run を Provider 実行失敗として作成しない。受理済み Run の dispatch 中に失敗した場合は Run attempt / dispatch 契約で別に収束させる。

## ID と所有権

| Codex ID          | WithMate の保持先                   | 用途                                                       |
| ----------------- | ----------------------------------- | ---------------------------------------------------------- |
| Thread ID         | ProviderBinding / binding history   | WithMate Session と Codex 会話の外部相関                   |
| Turn ID           | RunAttempt                          | WithMate Run と Codex 実行の外部相関                       |
| item ID           | RunEvent / RunOutputItem の外部相関 | delta、started、completed、重複 event の照合               |
| server request ID | live interaction                    | 実行中だけ保持する approval / elicitation 回答と解決の相関 |

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
- `thread/resume`が`active`なThreadと唯一の`inProgress` Turnを返した場合は、そのThread / Turn IDをcurrent active tupleとして復元する。Thread statusとcurrent Turnが矛盾する場合、または`inProgress` Turnが複数ある場合は、候補を選ばず`ambiguous`へ収束させる。
- `thread/started`を受理した後に対応するrequestが`remote_error`を返した場合は、作成済みの可能性を`effect: none`へ戻さず`ambiguous`へ収束させる。notificationとresponseはThread ID、CLI version、model provider、Workspace identity、ephemeral / persistent modeを一つの相関tupleとして照合し、いずれかが一致しない場合は候補を選ばない。responseで確定済みのThreadに初回の`thread/started`が遅延しても、同時にpending中の別`thread/start`へ帰属させない。response受理後に矛盾するnotificationを観測した場合は、そのThreadへの後続Provider mutationと送信済みmutationのaccepted projectionを止める。read-onlyの照合は許可し、再接続または上位のreconciliationまでmutationを再開しない。
- `thread/resume`の送信結果が`ambiguous`な間はmutation ownerを保持し、同じThreadへの`turn/start`、`turn/steer`、`turn/interrupt`を送信しない。resume前のmodel、Workspace、sandboxを後続mutationの検証値として使わず、上位のreconciliationまたはconnection closeまでmutationを再開しない。
- requestとresponseの`cwd`はhost path identityで照合する。Windowsの大文字・小文字など、同じWorkspace identityの表示差をside effect後のresponse不整合にしない。
- `thread/status/changed(idle)` だけで Run の正常完了を確定しない。

## Turn / Run lifecycle

| Codex Turn status | WithMate Run phase              | 判定                                                                  |
| ----------------- | ------------------------------- | --------------------------------------------------------------------- |
| `inProgress`      | `active`                        | 実測済み。live activityはitem / live interactionから投影する          |
| `completed`       | `completed`                     | `turn/completed` で正常完了を確定する                                 |
| `failed`          | `failed`                        | failure origin と redacted summary を別に保持する                     |
| `interrupted`     | `canceled` または `interrupted` | user cancel と相関できた場合だけ `canceled`。それ以外は `interrupted` |

### Run 開始

1. WithMateのRun admission、dispatch intent、必要な`creating` Binding intentをdurable commitする。
2. active Bindingがなければ前項の規則で`thread/start`を送り、Bindingのactive化をcommitする。受理不明のまま`turn/start`へ進まない。
3. dispatch record を `dispatching` へ durable update する。
4. `turn/start` を送る。
5. response / `turn/started` の Turn ID を RunAttempt と相関する。
6. `inProgress`を確認し、Runを`active`、runtime hostのlive activityを`running`へ投影する。

`thread/status/changed(active)` だけで Turn 開始成功を確定しない。Turn ID を相関できない間は同じThreadへ新しいTurnを送らず、current active tupleまたは`idle`の観測を待つ。`notLoaded`と`systemError`は新しいTurnの送信許可に使わない。

`turn/start`がpendingの間に、同じThreadで一意に相関できる`turn/started`または未観測のTurn IDを持つ`turn/completed`を受理した場合は、notificationをProvider受理の証拠とする。responseより先にnotificationを観測した場合や、その後に対応するrequestが`remote_error`を返した場合も、operationを同じTurnの`accepted`へ知識補正する。terminalが先行した場合は、同じTurnのstartedとterminalを順に上位へ通知する。以前のTurnですでに受理したterminalのduplicateは、新しい`turn/start`の副作用証拠にしない。notificationとresponseのTurn IDが一致しない場合は、notification側のTurnがすでにterminalでもcurrent Turnを選ばず、そのThreadへの新しいTurn mutationを再開しない。

### Run 完了

- `turn/completed` の status を terminal outcome の根拠にする。
- `thread/status/changed(idle)` は観測値であり、正常完了の根拠にしない。
- `completed` で final assistant candidate がある場合だけ final Message を作成する。空の final Message は作らない。
- `failed` / `interrupted` の assistant output は partial / assistant detail として保持できるが、final Message へ昇格させない。
- terminal 更新と final Message の論理確定は `docs/design/session-run-message-contract.md` の同一 domain transition 規則に従う。
- event queueまたはRunOutput予約のresource超過では、受理済みの`turn_terminal`を後続eventのために削除しない。terminal outcomeを優先して非terminal eventを縮退し、成功Runにも`runtime_resource_limit`のterminal diagnosticを残す。resource超過を正常な全量保存として扱わない。

## item lifecycle と順序

### 共通処理

- `item/started` で item ID、Turn ID、item type を登録する。
- delta notification は item ID で相関し、item 内の受信順に連結する。
- `item/completed` の確定 item を delta 連結結果より優先する。不一致は診断 event として残す。
- Provider 時刻を順序の基準にせず、WithMate が Run 内の単調増加 sequence を割り当てる。
- 同じ item event の再受信は external event ID または deterministic fingerprint で重複排除する。
- completed 後の未知 delta、item/started より先に届いた delta、別 Turn の item は domain state を進めず、bounded な診断対象とする。

## assistant message 分類

`codex-cli 0.145.0`のstable生成schemaでagentMessage itemの`phase`は省略可能で、既定値は`null`である。明示値は`commentary` / `final_answer` / `null`を許可し、field欠落と明示された`null`をphase unknownとして扱う。`gpt-5.6-luna` / `high`の隔離probeを3 Turn実行し、各Turnで`commentary` 1件、`final_answer` 1件、`null` 0件を観測した。既存の`0.144.6` probe 2回でも同じ構成だった。

| App Server item                     | WithMate 変換                               | 状態                                                                        |
| ----------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------- |
| `agentMessage.phase='commentary'`   | RunOutputItem `category='assistant_detail'` | runtime実測済み                                                             |
| `agentMessage.phase='final_answer'` | final assistant candidate                   | runtime実測済み。Turn成功完了までMessageとして確定しない                    |
| `agentMessage.phase=null`           | phase unknown item                          | stable schema確認。Lunaを含むruntimeでは未観測。受信時点でfinalと断定しない |

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

この fallback は runtime 契約 test で「`phase=null`の複数 agentMessage が 1 つの final response を構成する」ことが確認された場合に見直す。不明な item 全件を無条件に final Message へ連結しない。

## tool / command / file / reasoning 変換

| App Server item / event     | WithMate 変換                                           | 通常 hydrate         |
| --------------------------- | ------------------------------------------------------- | -------------------- |
| command execution           | RunOutputItem `operation` + RunEvent                    | count のみ           |
| file change                 | RunOutputItem `operation` + RunEvent                    | count のみ           |
| tool / MCP call             | RunOutputItem `operation` + RunEvent                    | count のみ           |
| reasoning / plan / progress | RunOutputItem `assistant_detail` または `diagnostic`    | 読み込まない         |
| usage / context             | RunOutputItem `telemetry`                               | 読み込まない         |
| warning / error             | RunOutputItem `diagnostic` + 必要な Run outcome summary | bounded summary のみ |
| 未知 item / event           | RunOutputItem `provider_metadata` + RunEvent            | 読み込まない         |

RunOutputItem は item ごとの bounded summary と詳細 payload 参照を分ける。stdout / stderr、diff、raw payload を summary と同じ JSON に入れない。Session の通常 hydrate は final Message だけを読み、RunOutputItem を join しない。

- `commandExecution.exitCode`はstable schemaのnullableなsigned int32として検証する。負値をProvider異常とみなさず、int32範囲外の値はknown-invalid payloadとして拒否する。
- token usageの`total`は累積値として各成分の単調増加を検証する。`last`は最新requestのusageへの置換値であり、前回値から減少してもregressionとはみなさない。ただし、同じ通知内では`total`の各成分が`last`以上でなければならない。

## approval / elicitation / user input

| Server request                          | Discriminator                                 | WithMate 変換                                     |
| --------------------------------------- | --------------------------------------------- | ------------------------------------------------- |
| `item/commandExecution/requestApproval` | method                                        | pending command approval                          |
| `item/fileChange/requestApproval`       | method                                        | pending file change approval                      |
| `item/permissions/requestApproval`      | method                                        | permission 種別を保った pending approval          |
| `item/tool/requestUserInput`            | method                                        | pending user input                                |
| `mcpServer/elicitation/request`         | metadataの`codex_approval_kind=mcp_tool_call` | pending MCP tool approval                         |
| `mcpServer/elicitation/request`         | `codex_approval_kind`なし、`mode=form`        | schema種別を保った pending MCP server elicitation |
| `serverRequest/resolved`                | request ID                                    | 対象 request の解決確認                           |

- server request IDとProvider item IDはAdapter内部の外部相関IDとして保持し、public interaction IDにはWithMate発行のopaque IDを使う。public snapshotとresponseへProvider IDを公開しない。
- request bodyと回答をlive activityへ埋め込まない。live activityは`waiting_approval` / `waiting_input`の代表表示だけとし、DBへ保存しない。
- public操作は`run interactions` / `run respond-interaction`とし、Provider固有method名を公開しない。snapshotとresponseのclosed union、Provider definition version、exact validationはADR 015を正本とする。
- Codex初期definitionのliteral kindと静的なpublic shapeは`schema/providers/codex/interaction-v1.schema.json`を正本とする。未知の`codex_approval_kind`、discriminatorなしの非form mode、未検証のform field種別はunavailableとして回答対象へ投影しない。
- safety-relevantなcommand、path、change集合、permission、question、option、form schemaをpublic上限内へ完全に投影できないrequestはunavailableとし、切り詰めた表示から回答を許可しない。command内のworkspace absolute pathは完全に識別できる場合だけ`<workspace>`起点へ置換し、外部absolute path、UNC、device path、file URI、home-relative path、parent traversal、または曖昧なpath表現が残るrequestはunavailableとする。file changeの表示pathはslash区切りのworkspace相対pathへ安全に正規化できる場合だけ回答可能とし、absolute、drive-qualified、parent-relative、未知change kindはunavailableとする。user inputのquestion ID / option label、MCP formのfield IDはsnapshot内で一意でなければならない。
- MCP server formは、同じTurnのMCP tool approvalに対する`serverRequest/resolved`より後のrequestだけを次段として受け入れる。先行formはdeclineしてTurnをinterruptし、正常な二段階round tripとして継続しない。
- user input responseはcurrent snapshotの全questionへ回答を1件ずつ持つ。current option label、またはProviderの`isOther`から投影した`allowOther=true`の場合だけ2,048 code point以下の自由入力を許可する。`isSecret=true`はsecure入力経路を実装して実測するまでunavailableとする。MCP form responseはacceptだけが`values`を持ち、field集合、requiredness、snapshot固有の`maxLength`へexact validationする。required fieldがなければ空の`values`を許可する。decline / cancelは値を持たず、Adapterは`content: null`へ変換する。
- 回答 operation は idempotency key を受け、解決済み request への二重回答を送らない。response admissionとRun cancelは同じper-Run mutation ownerで直列化し、write開始後の切断は`ambiguous`として再送しない。
- 解決後の事実はRunEvent、必要なbounded summaryはRunOutputItemに保存する。runtime hostまたはApp Server processの再起動後は、保存済み履歴だけから未解決requestを回答可能な状態へ復元しない。
- `codex-cli 0.145.0`ではcommand / file approvalのaccept / decline、turn scopeのpermission approval、feature有効時の`request_user_input`を実測した。MCPはdirect callとephemeral Threadのmodel Turnで完全round tripを実測した。model Turnではtool approvalへ空contentのplain acceptを返し、永続choiceを選ばず、その解決後に届くserver formへ別responseを返した。両requestの`serverRequest/resolved`、fixture response、MCP item terminal、Turn terminalを確認した。permissionとuser inputはrequestのThread / Turn / item ID、resolved、Turn terminalを確認したが、生成bindingに専用`ThreadItem` variantはないためitem terminalを要求しない。MCP interaction requestはThread / Turn IDを持つ一方でitem IDを持たず、後続のMCP item lifecycleより前にも届くため、request ownerとitem lifecycleを別に相関する。
- 今回実測したserver elicitationは`mode=form`だけである。`mode=url`と将来variantはProvider definitionへ公開せず、対応時にkind固有schema、response、terminal条件を追加のruntime evidenceで確定する。
- bounded client wait後のpending、stdio切断、responseとcancelの両順序、同一process上の10 active Runを実測した。競合はresponse先行4回、interrupt先行4回でresolved 1件、interrupted terminal 1件、副作用0件へ収束した。10並行TurnはexactなThread / Turn tupleごとに`turn/started`とterminalが各1件で、10区間すべてがterminal前に開始済みとなる最大同時active数10を示し、相関混線なく完了した。ただし、これは支持下限であってprocessの絶対上限ではない。stdio切断ではresponse送信後またはresolved後でもterminal eventを失い、副作用の不存在を一般化できない。`serverRequest/resolved`はrequest lifecycleの解決であり、単独でTurn、tool round trip、command副作用の完了を示さない。
- resolved後に同じresponseを再送したlive probeでは、追加error、追加resolved、追加item terminal、追加Turn terminal、副作用を観測しなかった。ただしduplicate response自体への独立ACKはprotocolにないため、受理か拒否かは断定しない。Application contract testではresponse admissionとcancel admissionを同じper-Run mutation ownerで直列化し、resolved後の再送を防ぎ、`write_attempted`後にterminal certaintyを失った場合は`ambiguous`へ収束させる。Provider側timeoutと切断後の副作用照合もApp Server eventだけでは確定しない境界として扱う。

## steer / interrupt

### steer

- `turn/steer` は `expectedTurnId` と active Run の外部 Turn ID が一致する場合だけ送る。
- `codex-cli 0.144.6`では不一致`expectedTurnId`とactive Turn不在を`-32600`で拒否し、一致時は同じTurn IDを返してsupplemental user Messageを同一Turn履歴へ反映した。
- supplemental Message の Provider 配送結果は accepted / rejected / ambiguous を区別する。
- `turn/steer.clientUserMessageId`と`userMessage.clientId`を同じThread / Turn tupleで相関する。matching notificationで配送を観測した後の非accepted responseを`effect: none`へ戻さず、矛盾時は`ambiguous`へ収束させる。accepted responseまたは`response_unknown`が先行した場合も、相関ownerをmatching notificationまたは対象Turnのterminalまでboundedに保持し、後続のtuple競合を見逃さない。
- 不一致、timeout、切断時に supplemental Message を後続 Run へ暗黙転用しない。
- public operationは`withmate run send-input`とし、Provider method名をCLI contractへ漏らさない。

### interrupt

- user cancel を durable に受理し、Run を `canceling` にしてから `turn/interrupt` を送る。
- `codex-cli 0.144.6`では空response、`thread/status/changed(idle)`、`turn/completed(interrupted)`の順を2回観測した。request成功だけでRunを`canceled`にしない。
- `turn/completed(status='interrupted')` を user cancel request と相関できた場合だけ `canceled` にする。
- 対象Turnのmatching terminal notificationを受理した後に対応する`turn/interrupt` requestが`remote_error`を返した場合は、terminal statusが`completed`、`failed`、`interrupted`のいずれでも、interruptと自然終了の競合を`effect: none`へ戻さず`ambiguous`へ収束させる。
- timeout、process 終了、相関不能は `interrupted` に収束させる。
- public operationは`withmate run cancel`とし、Provider method名をCLI contractへ漏らさない。

## 切断・再起動・復旧

1. durable な dispatch state と外部 Thread / Turn ID を読み込む。
2. `pending` で Provider 未送信を証明できる場合だけ送信を開始する。
3. `dispatching` 以降で受理を証明できない場合は自動再送しない。
4. persistent Thread / Turnへ一意に再接続でき、resume結果が同じTurnの`inProgress`を示す場合だけ監視を再開する。stdio App Server process異常終了後は`codex-cli 0.144.1`で`interrupted`となるため監視を再開しない。
5. Provider 未送信、terminal outcome、継続可能な外部実行のどれも証明できない Run は `interrupted` にする。

`thread/read`の履歴は照合補助であり、欠落したRunEventやMessageを推測で自動生成しない。切断前に受信済みの未確定assistant deltaがpersistent Turn履歴へ残らないことを確認している。streaming deltaを永続化しない共通方針に従い、crash時の未確定draft消失を許容し、復旧時にpartial outputを推測生成しない。

明示的なAdapter closeはtransportからの新規受信を止めるが、close開始前にAdapter eventへ正規化済みのqueueを破棄しない。consumerはclose後もqueueを受け取り、`nextEvent()`がclosedを返すまでdrainする。`nextEvent()`で取得したeventはEvent Serviceの受理完了までconsumerが保持し、受理失敗時は同じeventを再試行して後続eventを先に処理しない。runtime hostはこのdrainとEvent Serviceへの受け渡しが完了してからgenerationを解放する。

WindowsではCodex managed daemon lifecycleが非対応のため、CAS-017は`blocked`である。初期構成はdaemonへ再接続せず、WithMate runtime hostがstdio connectionを保持する。CLI disconnectはruntime hostへのlocal IPCだけを閉じ、App Server connection、live Run、draft、interactionを終了しない。runtime host crash時は前記のProvider照合規則へ進む。

## unknown / duplicate / out-of-order event

- 未知 notification / item type で client loop を停止しない。
- 未知eventのraw Thread / Turn / item IDはAdapter内部のowner照合とdedupeにだけ保持し、runtime hostが保存先を選んだ後はpublicまたは永続化する`provider_metadata` / diagnostic payloadへ含めない。public projectionはWithMate Run / Output identity、allowlist化したcategory、件数、bounded summary、redaction有無だけを残す。owner tupleが完全一致しないeventは現在のRunへ補完しない。
- 診断へ追加情報が必要な場合もraw payload自体は保存せず、allowlist化したcategory、件数、bounded summary、redaction有無だけをRunOutputItem `provider_metadata`の遅延読み込みpayloadにする。
- duplicate / out-of-order event で Run phase、Message、live interaction を重複更新しない。
- terminal Run に届いた未知 event で Run を non-terminal へ戻さない。
- synthetic client self-testでは未知notificationをbounded / sanitizedな`other`診断へ変換した後も既知terminal eventの処理を継続し、public diagnostic projectionへraw method / payloadを含めないことを確認した。受信時の内部bufferからraw wire messageが直ちに消去されることまでは、このself-testの検証対象にしていない。

## model / capability

- `model/list` を cursor / limit で全 page 取得し、model ID、表示名、reasoning effort、入力 modality などを WithMate の capability model へ変換する。stable生成schemaで省略可能な`inputModalities`が欠落した場合は、schema既定値の`["text", "image"]`を適用する。
- freshなstartまたはretry commandは、durable admissionより前にread-only capability preflightを行い、同じruntime generationの`model/list` snapshotでmodel、reasoning effort、text input modalityを検証する。明示されたmodelは`selectable`も要求する。未対応の組はProvider Thread、Turn、durable Runを作成せず`provider_capability_unavailable`として拒否する。catalog / transportを取得できない場合はretryable、決定的なtuple不一致はnon-retryableとする。exact durable replayはcurrent catalog driftやruntime停止に依存させずpreflightを省略する。Thread / Turn mutation時にも同じ検証を残す。
- catalog は CLI version / account で変動するため、ハードコードしない。
- hidden model は通常の選択肢に自動追加しない。
- retryでmodel overrideを省略した場合は、source Runのexecution snapshotに保存したmodelを`inherited` provenance付きで受け取る。AdapterはBindingを新規作成する場合の`thread/start`を含め、そのmodelを`thread/start`、`thread/resume`、`turn/start`へ指定し、同じThreadの後続Runがmodelを変更していてもsource Runの値へ戻す。継承値は新規選択ではないためhidden historyを許可し、`selectable`条件は要求しないが、catalog上の存在、入力modality、reasoning effortの組は検証する。明示overrideは従来どおり`selectable`を要求する。`modelSelection`はAdapter内部の検証provenanceであり、Codex App Serverのwire payloadへ送らない。
- `turn/start`のmodel overrideをresponseまたは一意に相関した`turn/started`で受理した後は、そのmodelをThreadのcurrent modelとして後続Turnのcapability検証に使う。notification先行で暫定相関した後に`request_not_sent`が未送信を証明した場合は元のcurrent modelへ戻し、受理を確認できないrequestだけでcurrent modelを変更しない。
- `codex-cli 0.145.0`では`modelProvider/capabilities/read`の`imageGeneration`、`namespaceTools`、`webSearch`がすべて`true`だった。通常一覧7件、`includeHidden=true`の完全一覧8件、hidden 1件を確認し、`gpt-5.6-luna`はhiddenではなく、default effortが`medium`、supported effortが`low` / `medium` / `high` / `xhigh` / `max`だった。これらは起動時snapshotとして検証し、将来versionへ固定値として一般化しない。
- orchestration API は Provider 名を Agent へ露出せず、WithMate の model / reasoning / feature 表現へ変換する。

## 初期実装で必要な Adapter operation

```text
listModels
startThread
resumeThread
readThread
startTurn
steerTurn
interruptTurn
respondInteraction
close
```

handshakeの`initialize` / `initialized`はtransportが所有し、Adapterから再送しない。`resumeThread`、`steerTurn`、`interruptTurn`、`respondInteraction`は対象versionのruntime evidenceとcontract testをGateに利用可能とする。`respondInteraction`はCodex definition versionが所有するclosed unionを受け、method名だけでresponse shapeを選ばない。runtime evidenceのないkindはcapabilityとして公開しない。

Thread作成・再開の送信結果が`ambiguous`な場合、Adapterはmutation reservationをconnection closeまで保持する。上位runtimeはそのgenerationを後続Thread mutationへ再利用せず、Provider processのclose完了を確認してからgeneration ownerを解放する。Adapterとtransportは同時closeだけをdedupeし、失敗したclose結果を永久cacheしない。processまたはnative handleの解放に失敗した場合は参照と未完了状態を保持し、同じownerを後続closeで再試行する。Windows Job Objectの設定、process割当て、一時process handle解放など、process startupのpartial acquisitionで失敗したownerもstructured errorを介してtransportへ引き渡す。Adapter公開前のstartup cleanupも同じ完了条件を使い、close失敗中に後続generationまたはsuccessor processを開始しない。

## 契約 test matrix

### 基本通信

- transport handshake完了前にAdapter operationを公開しないこと
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
- user input / MCP tool approval / MCP server elicitation 回答とkind不一致の拒否
- steer の `expectedTurnId` 一致 / 不一致
- interrupt と natural completion の競合
- App Server crash / client crash / stdin close
- runtime host IPCのclient-only切断、response loss、snapshot / cursor再接続、欠落event
- unknown / duplicate / out-of-order notification

## 未検証事項と実装 Gate

| 項目                                | 現在                                                           | Gate                                                                            |
| ----------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| persistent Thread resume / read     | completed Turnとstdio process異常終了を実測済み                | runtime host crashのprocess testで照合と`interrupted`収束を確認                 |
| `agentMessage.phase`のruntime一貫性 | Luna 3 Turnでexplicit commentary / finalを実測済み             | final Message mapperの契約test                                                  |
| `phase=null` fallback               | stable schema確認、Lunaを含むruntimeでは未観測                 | 1件 / 複数unknown itemのmapper契約test                                          |
| interrupt                           | responseからterminalまで実測済み                               | durable cancelとの相関と競合のcontract test                                     |
| steer                               | 一致 / 不一致 / terminal後と履歴を実測済み                     | notification先行時のaccepted / ambiguous deliveryをruntime実測                  |
| active Thread resumeのitem再配信    | current active tupleの復元をcontract test済み                  | 既存itemの再配信有無と重複排除をruntime実測                                     |
| command / file approval             | accept / decline、bounded wait、duplicate、stdio切断を実測済み | timeout、duplicate ACK、切断後の副作用はclient側の保守的収束を実装Gateにする    |
| permission / user input             | turn scope / feature、method別terminalを実測済み               | Provider timeoutをclient deadlineとして実装する                                 |
| MCP elicitation direct call         | `0.145.0`で完全round trip実測済み                              | regression probeを維持                                                          |
| MCP elicitation model Turn          | tool approvalとserver formの二段round trip実測済み             | discriminator、永続grantなし、全terminalのregression probeを維持                |
| 複数 Thread 並行実行                | Lunaで最大同時active数10とevent / owner分離を実測済み          | 10を支持下限とし、host所有の上限、backpressure、resource limitを実装Gateにする  |
| unknown notification                | synthetic client self-test済み                                 | production Adapter clientの契約testとして同じfail-open / sanitize契約を固定する |

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
