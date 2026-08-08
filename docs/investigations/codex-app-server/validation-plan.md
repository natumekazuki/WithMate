# Codex App Server Validation Plan

- 作成日: 2026-07-10
- 最終更新: 2026-08-02
- 対象 version: live runtimeは`codex-cli 0.146.0`、生成schema baselineは`0.145.0`（既存の基本通信は`0.144.1`、`0.144.6`でも実測）
- 関連設計: `docs/design/provider-integration.md`
- 状態: CAS-001〜016を実施済み / CAS-017は現在環境でblocked

## 目的

Codex App Server を WithMate の Provider Adapter から利用するため、schema だけでは確定できない message 順序、状態遷移、再接続、承認、追加入力を小規模に検証する。

検証は product implementation と分離し、無害な固定 prompt、機密情報を含まない一時 workspace、最小権限で実施する。

## 証跡の記録方針

- token、account 情報、rate limit、installation ID、端末名を記録しない。
- local absolute path は `<workspace>`、`<home>` へ置換する。
- Thread ID、Turn ID、item ID は `<thread-id>` などへ置換する。
- payload 全体ではなく、設計判断に必要な request / notification 順序だけを残す。
- model 一覧は取得可否と capability field の存在を記録し、変動する catalog 全体は保存しない。
- CLI releaseは観測値として記録し、完全一致またはSemVer rangeでprobeを停止しない。互換性は実payloadのvalidation、request / notification相関、terminal、cleanupで判定する。

## 検証項目

| ID      | 確認内容                                  | 期待結果                                                                                                                                                 | 優先度 |
| ------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| CAS-001 | process 起動と initialize                 | response を受け、以後の request を送信できる                                                                                                             | 必須   |
| CAS-002 | model 一覧                                | pagination 可能な catalog を取得できる                                                                                                                   | 必須   |
| CAS-003 | ephemeral Thread 作成                     | Thread ID と初期状態を取得できる                                                                                                                         | 必須   |
| CAS-004 | Turn 開始                                 | Turn ID と `inProgress` を取得できる                                                                                                                     | 必須   |
| CAS-005 | assistant streaming                       | delta を順序付きで受信できる                                                                                                                             | 必須   |
| CAS-006 | 正常完了                                  | item、Thread、Turn の terminal event を識別できる                                                                                                        | 必須   |
| CAS-007 | Thread 読取                               | ephemeral / persistent の制約を識別できる                                                                                                                | 必須   |
| CAS-008 | persistent Thread 再開                    | process 再起動後に会話を継続できる                                                                                                                       | 高     |
| CAS-009 | Turn interrupt                            | response、Thread notification、terminal statusの順序とuser cancel相関を確定できる                                                                        | 高     |
| CAS-010 | Turn steer                                | 受理、active Turn不在、`expectedTurnId`不一致、同一Turn履歴への反映を確定できる                                                                          | 高     |
| CAS-011 | command / file approval                   | server request へ allow / deny を返せる                                                                                                                  | 高     |
| CAS-012 | permission / user input / MCP elicitation | feature / capability gate、pending state、回答、MCP tool result、Turn再開を相関できる                                                                    | 高     |
| CAS-013 | stdio App Server異常終了                  | 未完了Runを復旧または`interrupted`判定できる                                                                                                             | 高     |
| CAS-014 | 複数 Thread の並行実行                    | event を Thread / Turn / item ごとに相関できる                                                                                                           | 中     |
| CAS-015 | 未知 notification                         | client が停止せず診断記録できる                                                                                                                          | 中     |
| CAS-016 | assistant phase 分類                      | `commentary` / `final_answer` / `null` とTurn成功完了からfinal Message / assistant detailを一意に分類できる                                              | 必須   |
| CAS-017 | daemonへのclient-only再接続               | App Server daemonを停止せずclientだけ切断し、active Turn、subscription、欠落event、外部副作用を判定できる。daemon lifecycle非対応環境では`blocked`とする | 高     |

## 基本通信の実行条件

- `thread/start` は `ephemeral: true` とする。
- sandbox は `read-only`、approval policy は `never` とする。
- prompt は固定文字列の返答だけを要求し、tool や file access を禁止する。
- 検証 workspace は repository 外の一時 directory とする。
- process は検証後に標準入力または interrupt で終了する。
- すべてのlive probeは、invocation内の最初のTurnを開始する前に`modelProvider/capabilities/read`と`model/list(includeHidden=false/true)`で`gpt-5.6-luna`と選択reasoning effortの組を検証し、そのinvocationで開始する全Turnについて、`thread/start.model`、`thread/resume.model`、`turn/start.model / effort`のうち各methodが持つfieldへ同じ組を明示する。reasoning effortは`ultra`を使用せず、現在のprobeは`high`を使う。
- live検証全体のTurn総数には上限を設けない。1回のprobeに対する最大10 Turnと14分 / 15分のdeadlineは、失敗時の回収を保証するinvocation単位の安全境界として維持する。

## lifecycle 検証時の追加条件

CAS-008 以降は永続 Thread、長時間 Turn、承認対象 action を扱うため、個別の実行手順と cleanup 方針を追加してから実行する。特に file 変更や command 実行を伴う検証は、専用の破棄可能 workspace と明示的な test command を使用する。

CAS-008 / CAS-013 の復旧 probe は次の条件で実行する。

- `docs/investigations/codex-app-server/recovery-probe.mjs` を使用する。
- repository 外に一時 workspace を作り、終了時に削除する。
- persistent Thread、`read-only` sandbox、`approvalPolicy=never` を使用する。
- completed Turn の App Server 再起動後に `thread/read(includeTurns=true)` と `thread/resume` を確認する。
- active Turn は最初の assistant delta を受信した直後に App Server process tree を終了し、別 process から同じ Thread ID を `thread/resume` する。
- terminal notificationはTurn IDだけでなくexactなThread / Turn owner tupleで照合する。復旧待機のtimeoutだけを`thread/read`へfallbackし、transport、RPC、resource failureをtimeoutとして隠さない。
- prompt は file / command / network accessを伴わない固定出力だけにする。
- Thread / Turn / item ID、absolute path、本文、token / account情報を証跡に残さない。

実行 command:

```text
node docs/investigations/codex-app-server/recovery-probe.mjs --preflight-only
node docs/investigations/codex-app-server/recovery-probe.mjs
```

CAS-009 / CAS-010 / CAS-016 / CAS-017のruntime contract probeは次の条件で実行する。

- `docs/investigations/codex-app-server/runtime-contract-probe.mjs`を使用する。
- repository外の一時workspaceと、probe自身が起動したstdio App Serverだけを使用する。
- `read-only` sandbox、`approvalPolicy=never`、tool / file / network accessを要求しない固定promptを使用する。
- CAS-009は最初のassistant delta後に`turn/interrupt`を送り、responseとterminal notificationの受信順序を記録する。
- CAS-010はactive Turnに対して不一致`expectedTurnId`、一致`expectedTurnId`、terminal後の3ケースを送り、persistent Thread履歴にsupplemental user Messageが1件だけ反映されたことを本文を出力せず確認する。
- CAS-010の履歴確認にはpersistent Threadを使うため、repository外workspaceを削除してもsyntheticなThreadが設定済みCodex profileへ残る可能性がある。probeはThread IDや本文を出力せず、既存Threadを変更しない。
- CAS-016は明示的なcommentaryとfinal answerを要求し、completed agentMessageのphaseだけを集計する。`null`が観測されなくても、stable schemaのnullable contractを削除しない。
- CAS-017はdaemonのread-onlyなversion照会だけを許可し、既存daemonのinstall、start、stop、restart、設定変更を行わない。隔離不能またはplatform非対応なら`blocked`とする。
- terminalとretry可能なerrorはexactなThread / Turn owner tupleで照合し、別Threadの同一Turn IDを受理しない。
- stdoutにはversion、sanitizedな順序、status、件数だけを出し、ID、本文、account情報、absolute path、raw payloadを出さない。

実行 command:

```text
node docs/investigations/codex-app-server/runtime-contract-probe.mjs --preflight
node docs/investigations/codex-app-server/runtime-contract-probe.mjs
```

CAS-011 / CAS-012のinteraction contract probeは次の条件で実行する。

- `docs/investigations/codex-app-server/interaction-contract-probe.mjs`を使用する。
- repository外の一時workspace、ephemeral Thread、probe自身が起動したstdio App Server、local stdio MCP fixtureだけを使用する。
- hooksを無効化し、既存MCP serverを無効化したeffective configを`config/read`で確認してからTurnを開始する。
- command / fileのacceptは一時workspace内のmarker作成だけを許可し、declineではmarkerが存在しないことを確認する。
- command approvalはrequestの`cwd`、CodexのPowerShell wrapper、単一`commandActions[].command`を固定値へ照合し、network contextまたはnetwork policy提案を含むrequestを拒否する。boundedなexec policy提案がrequestに付く場合も、probeはplain `accept` / `decline`だけを返し、`acceptForSession`またはrule適用responseを送らない。file approvalは同じitemの`item/started`または`item/fileChange/patchUpdated`から変更pathを取得し、全pathが固定markerと一致し、`grantRoot`がない場合だけ回答する。
- permissionはturn scopeのworkspace writeだけを要求し、sessionまたはpersistent grantを作らない。
- permission、user input、MCP interactionもexactなThread / Turn ownerに加え、workspace、question ID / option、server name、tool target / arguments、form schemaを固定値へ照合する。permission / user inputはrequestのitem IDも照合する。MCP interaction requestはitem IDを持たないため、存在しないIDや先行`item/started`をadmission条件にせず、後続のMCP item lifecycleを別に検証する。不一致requestにはacceptを返さず、そのcaseを`blocked`とする。command / file / permission / MCPはprotocolで定義されたdeclineだけを返し、送信、resolved、terminal、pending、副作用の実測値を記録する。user inputはdecline responseを持たないため回答を送らず、exactなThread / Turnをinterruptして同じ実測値を記録する。
- `request_permissions`とdefault modeの`request_user_input`は対応するfeatureを明示的に有効化する。experimentalなserver requestを扱う接続は`initialize.capabilities.experimentalApi=true`を宣言する。
- MCP tool approvalとserver formは同じ`mcpServer/elicitation/request`を使うため、metadataの`codex_approval_kind=mcp_tool_call`をdiscriminatorとして別interactionに分類する。stable protocolの`_meta`と、`0.145.0`のlive probeで観測した`meta` aliasは同じ意味へ正規化する。tool approvalは隔離済みserver、固定tool name、nameが省略されたruntimeでは固定description、固定arguments、空schemaを照合し、`{action: "accept", content: {}}`だけを返す。metadataの`persist`がchoiceを広告してもsession / alwaysの選択をresponseへ含めない。
- MCP server formはtool approvalの`serverRequest/resolved`より後のsequenceから別requestとして待ち、固定messageとbounded schemaを照合してkind固有contentを返す。formが解決通知より前に届いた場合はdeclineしてTurnをinterruptし、未知の`codex_approval_kind`、discriminatorなしの非form modeと同様に`blocked`とする。入口とterminal auditは同じowner predicateを使い、terminalまでの同一ownerに属する全interaction methodを再集計する。その全体がtool approvalとserver formの各1件だけであり、別request ID、各IDの`serverRequest/resolved`が1件ずつ、tool request、tool resolved、form request、form resolvedの順序であることを要求する。別kind、owner表現が異なるMCP request、追加・再配送requestまたはduplicate resolvedは`blocked`とする。fixtureのelicitation response受信、tool result送信、`item/completed(completed)`、`turn/completed(completed)`も別々に観測する。`requestLifecycleStatus=resolved`と`roundTripStatus=completed`を分離し、requestの順序・件数、fixture stageの完全一致、MCP item terminal、Turn terminalが揃わなければoverall `blocked`とする。
- 各live probeはinvocation内の最初のTurn開始前に、`modelProvider/capabilities/read`の3 boolean、`model/list(includeHidden=false/true)`のpagination / visibility整合、Lunaの`id / model`、default / supported reasoning effortを確認する。catalog全体や可変の説明文は証跡へ保存しない。
- 1回のprobeは最大10 Turn、main phaseを14分、process終了とtemp削除を含むtotalを15分とする。これは全検証のTurn総数上限ではない。すべてのrequest、notification wait、同期subprocessにremaining deadlineを適用し、main deadline後は新しいTurnを開始しない。active Turnのinterruptとprocess tree回収はcleanup budget内で行う。
- cleanupはsetup直後から`finally`で所有する。WindowsではApp Serverを起動指示待ちsupervisorごとJob Objectへ割り当てた後にだけCodexをspawnする。Linuxでは`Delegate=yes`、`KillMode=control-group`の一時systemd user serviceを作り、専用cgroup v2の`cgroup.kill`をwrite-openしてからsubjectのlaunch設定を渡す。subject、内側supervisor、`systemd-run` wrapperのどれが先に終了しても、親は保持済みcgroup handleから同じtreeだけを終了できる。`cgroup.kill`へのwriteが失敗した場合は、所有権を検証した同じunit名に対する`systemctl --user stop`をreleaseの独立fallbackとする。systemd user managerとdelegated cgroup v2を利用できないPOSIXではsubjectをspawnする前にfail-closedとする。fixtureを含むdescendantはOS ownerからだけ終了し、audit PIDは終了確認にだけ使う。discovery用を含む全App Server owner、auditで観測したfixtureの終了、sentinel、temp root削除後の不存在を別々に確認する。process ownershipのself-testでは、WindowsのJob termination / assignment失敗、Linuxのdelegated cgroup open失敗、cgroup handle取得後かつsubject launch前の失敗、`cgroup.kill` write失敗からexact unit fallback、subject先行、内側supervisor先行、wrapper先行、App Server client停止中のwrapper先行、短命subject後の非干渉をplatform固有caseとして注入し、partial owner、unit、descendantの回収を確認する。
- main deadlineとcleanup deadlineを分け、cleanupは全ownerとfilesystem処理へaggregate budgetを割り当てる。interruptはmain deadline内のbounded waitだけを使い、temp削除はtimeout可能な非同期処理とする。total 15分のwatchdog到達時は非0でprobe processを終了する。WindowsはJob Objectのkill-on-closeで同じtreeを回収する。Linux live probeはdelegated cgroupのprimary terminationと監査済みexact unitへのrelease fallbackを順に試し、両方が失敗した場合は`cleanup=failed`として非0終了するが、probe単体ではunitまたはdescendantの不残存を保証しない。この場合は、通常cleanup failureまたはhard watchdogの出力にあるboundedな`cleanupRecovery[]`から`kind=systemd_user_unit`のexact `unitName`を取得し、外側ownerまたはoperatorが停止してinactiveまたは不存在まで確認する。`unitName`はprobeが生成する固定prefixと32桁hexへ一致する場合だけ投影し、未知owner identityは出力しない。self-testはownerが残る間はwatchdogを解除せず、primary terminationとreleaseを両方失敗させる外側process testでboundedな終了を確認する。Windowsはprocess終了時のJob close、Linuxは監査済みの正確なunit identityを使う外側cleanupにより、wrapper・supervisor・subject・descendantの消滅とLinux unitのinactiveまたは不存在を確認する。いずれかを確認できなければ`verified`を報告しない。
- App Server JSONLはnewline受信前から1行256 KiBをbyte単位で数え、接続当たり4,096件、UTF-8合計4 MiBでfail-closedとする。上限超過は単調なterminal transport failureとし、buffer済みeventを含む現在・将来のwait、pending request、top-level overallを失敗へ固定してeventを保持しない。cleanup対象から外れたdiscovery clientも別のtransport履歴に残し、停止後の成功で上書きしない。MCP fixture auditも共有file全体を64件、64 KiBへ制限し、writerはprocess再起動をまたぐ排他区間内で既存aggregateを再検証し、readerも超過を拒否する。未知audit recordはraw値を捨てず固定`other`へ写像してexact lifecycleを不成立にする。stdoutのitem観測結果は通常経路とmissing-terminal診断のどちらもevent、allowlist化したtype / status、件数だけへ集約し、Provider item IDを出力しない。
- public interaction contractのself-testは、重複question / option / field、`allowOther=false`のoption外回答、自由入力上限超過、required field欠落、prototype由来key、field上限超過、optional-only formの空accept、MCP formのdecline / cancel、oversized command、257件目のchange、上限超過path / formをnegative caseとして固定する。`allowOther=true`のbounded自由入力とcurrent option labelはpositive caseにし、`isSecret=true`はsecure入力経路を実装するまでunavailableとする。file changeの`displayPath`はslash区切りのworkspace相対pathだけを回答可能とし、absolute、drive-qualified、parent-relative、backslash、空segment、全Unicode `Cc`、bidi control、未知change kindはunavailableとする。文字列長はJSON Schemaと同じUnicode code point数で数え、上限ちょうどと1超過を確認する。safety-relevant contentはtruncateして回答可能にしない。
- `requestLifecycleStatus`、`roundTripStatus`、payload validation、transport、cleanupを機械判定し、sanitizedなoverall statusへ反映する。
- stdoutにはversion、sanitizedな順序、allowlist化したterminal / prewarm status、件数、fixtureの固定lifecycle tokenまたは`other`だけを出す。payload mismatchの診断はbooleanとkey / action件数だけへ固定し、通常経路とfallbackのどちらにもID、本文、absolute path、未知key / action type、未allowlistのProvider status、raw stderrを出さない。
- command / file approvalはrequest itemの`item/started`と同じitem IDのterminalを要求する。permission / user inputは生成bindingに専用`ThreadItem` variantがないため、requestのThread / Turn / item ID、`serverRequest/resolved`、Turn terminalを要求し、存在しないitem terminalを完了条件にしない。MCP interaction requestはThread / Turn owner、request IDと`serverRequest/resolved`を照合し、後続のMCP tool call itemとTurn terminalを別のlifecycleとして要求する。
- CAS-014は同一process上で2つのactive Runを開始し、toolなしと片方がpending approvalの各caseでThread / Turn / item owner、terminal件数、interaction件数、resolved ownerを検証する。加えてinvocation上限と同じ10件のtoolなしTurnを同時開始し、exactなThread / Turn tupleごとに`turn/started`から`turn/completed`までの区間を集計する。10区間が実際に重なり、各start / terminalが1件、cross-owner eventが0件の場合だけ10を支持下限とする。有限のprobeからProviderの絶対上限は主張しない。
- response / cancel競合はresponse先行とinterrupt先行を別modeで繰り返し、interaction、resolved、Turn terminal、副作用のexact countを検証する。stdio切断はresponse送信直後、遅延後、resolved後を分け、terminalを受信できない場合にeffect certaintyを推測しない。
- resolved後の重複responseは、安全なdeclineを1回解決した後に同じrequest IDへ再送する。`serverRequest/resolved`、item / Turn terminal、副作用、error notificationを観測するが、server response自体にresponse ACKがない場合は重複側の受理 / 拒否を推測しない。
- CAS-015はunknown notificationと後続の既知terminalを同じsynthetic streamへ注入し、clientが停止せず、public diagnostic projectionへ未知method / payloadを含めず固定`other`へ縮退したbounded diagnosticだけを残すself-testで扱う。受信時の内部bufferからraw wire messageが直ちに消去されることは検証対象にしない。

実行 command:

```text
node docs/investigations/codex-app-server/interaction-contract-probe.mjs --follow-up-preflight
node docs/investigations/codex-app-server/interaction-contract-probe.mjs --self-test
node docs/investigations/codex-app-server/interaction-contract-probe.mjs --approval-live
node docs/investigations/codex-app-server/interaction-contract-probe.mjs --follow-up-live
node docs/investigations/codex-app-server/interaction-contract-probe.mjs --mcp-direct
node docs/investigations/codex-app-server/interaction-contract-probe.mjs --mcp-turn-diagnostic
node docs/investigations/codex-app-server/interaction-contract-probe.mjs --mcp-turn-warmup-diagnostic
node docs/investigations/codex-app-server/interaction-contract-probe.mjs --permission-live
node docs/investigations/codex-app-server/interaction-contract-probe.mjs --user-input-live
node docs/investigations/codex-app-server/interaction-contract-probe.mjs --disconnect-live
node docs/investigations/codex-app-server/interaction-contract-probe.mjs --disconnect-resolved-live
node docs/investigations/codex-app-server/interaction-contract-probe.mjs --race-live
node docs/investigations/codex-app-server/interaction-contract-probe.mjs --race-interrupt-first-live
node docs/investigations/codex-app-server/interaction-contract-probe.mjs --multi-run-live
node docs/investigations/codex-app-server/interaction-contract-probe.mjs --duplicate-after-resolved-live
node docs/investigations/codex-app-server/interaction-contract-probe.mjs --parallel-batch-live
node docs/investigations/codex-app-server/interaction-contract-probe.mjs --phase-live
```

## 完了条件

- 各項目が `pass`、`fail`、`blocked`、`not_run` のいずれかで記録される。
- 実行した Codex CLI version と OS を記録する。
- request / notification の相関 key と terminal 判定を説明できる。
- Provider Adapter の状態遷移に反映できる。
- 未実施項目と残リスクが `validation-results.md` に残る。
