# Codex App Server Validation Results

- 実施日: 2026-07-10、2026-07-12、2026-07-20、2026-07-31、2026-08-01、2026-08-02
- 状態: CAS-001〜016を実施済み。主要interaction、10件の同時active Run、response / cancel競合、stdio切断を実測し、daemon client-only再接続だけが現在環境でblocked
- 検証計画: `docs/investigations/codex-app-server/validation-plan.md`
- 関連設計: `docs/design/provider-integration.md`, `docs/design/codex-app-server-adapter-contract.md`

## 実行環境

| 検証セット                       | OS / runtime                                      | Codex CLI | Transport           | 条件                                                                                              |
| -------------------------------- | ------------------------------------------------- | --------- | ------------------- | ------------------------------------------------------------------------------------------------- |
| 基本通信、persistent Thread復旧  | Windows 10.0.26200, x86_64                        | `0.144.1` | stdio JSONL         | repository外workspace、ephemeral / persistent、read-only、approval=never                          |
| runtime contract再実測           | Windows 10.0.26200, x86_64 / Node.js `24.18.0`    | `0.144.6` | stdio JSONL         | repository外workspace、ephemeral / persistent、read-only、approval=never                          |
| interaction contract実測         | Windows / Node.js `24.18.0`                       | `0.145.0` | stdio JSONL         | repository外workspace、ephemeral、isolated hooks / MCP、networkなし、persistent grantなし         |
| Luna追加実測                     | Windows / Node.js `24.18.0`                       | `0.145.0` | stdio JSONL         | `gpt-5.6-luna`、reasoning effort `high`、追加23 Turn、invocation単位の最大10 Turn                 |
| vertical slice closure再実測     | Windows / Node.js `24.18.0`                       | `0.145.0` | stdio JSONL         | `gpt-5.6-luna`、reasoning effort `high`、追加62 Turn、isolated exact-version runtime              |
| capability admission closure実測 | Windows / Node.js `24.18.0`                       | `0.145.0` | stdio JSONL         | `gpt-5.6-luna`、reasoning effort `high`、追加56 Turn、exact-version runtime                       |
| release非依存Decoder closure実測 | Windows / Node.js `24.18.0`                       | `0.146.0` | stdio JSONL         | `gpt-5.6-luna`、reasoning effort `high`、追加68 Turn、schema baseline `0.145.0`                   |
| Linux process ownership          | WSL2 Ubuntu / Linux 6.6.114.1 / Node.js `24.18.0` | 対象外    | systemd / cgroup v2 | 公式Node archiveのSHA-256を検証、一時copy、external Turn 0、delegated cgroupの実process self-test |

2026-07-20の既定shellはNode.js `22.22.1`だったため、repository要件を満たすinstalled Node.js `24.18.0`の実体を明示してprobeを2回実行した。Codex CLIはPATH上の`0.144.6`を使用した。

## schema 調査

`codex-cli 0.144.6`で次のcommandを使い、stable / experimental schemaを一時directoryに生成した。生成物はversion依存のためrepositoryへ追加していない。

```text
codex app-server generate-json-schema --out <temporary-stable-directory>
codex app-server generate-json-schema --experimental --out <temporary-experimental-directory>
```

| schema       | file 数 | 結果     |
| ------------ | ------: | -------- |
| stable       |     267 | 生成成功 |
| experimental |     337 | 生成成功 |

`codex-cli 0.145.0`でもschemaを一時directoryへ生成し、granular approval、permission、`request_user_input`、MCP elicitation、model Provider capability、model visibility、nullableなagentMessage phaseの型を確認した。file数は上表の`0.144.6`の記録と混同しない。

2026-08-02の先行closure再実測時、通常PATH上のCodex CLIは`0.146.0`だった。当時のversion gateがlive Turn開始前に安全に`blocked`としたため、session-localな一時directoryへexact `0.145.0`を隔離配置し、そのruntimeだけをPATH先頭へ置いた。この履歴を受けてCLI release gateを廃止し、後続のrelease非依存Decoder closureでは通常PATH上の`0.146.0`を直接使用した。

## 検証結果

| ID      | 状態      | 実際の結果                                                                                                                                                                     | 備考                                                                                                                                                             |
| ------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CAS-001 | `pass`    | `initialize` response を受信し、後続 request を処理できた                                                                                                                      | wire 上の message に `jsonrpc` field はなかった                                                                                                                  |
| CAS-002 | `pass`    | `model/list(includeHidden=false/true)`のpaginationとvisibilityを照合し、`modelProvider/capabilities/read`の3 capabilityを取得できた                                            | Lunaはvisibleで、`high`はadvertise済み。catalog内容はversion / accountで変動する                                                                                 |
| CAS-003 | `pass`    | ephemeral Thread を作成し、Thread ID と `idle` を取得できた                                                                                                                    | `thread/started` も受信した                                                                                                                                      |
| CAS-004 | `pass`    | `turn/start` response で Turn ID と `inProgress` を取得できた                                                                                                                  | 続けて `thread/status/changed(active)`、`turn/started` を受信した                                                                                                |
| CAS-005 | `pass`    | `item/agentMessage/delta` を複数回受信し、連結後の文字列が期待値と一致した                                                                                                     | item ID で相関できた                                                                                                                                             |
| CAS-006 | `pass`    | assistant の `item/completed`、Thread の `idle`、Turn の `completed` を受信した                                                                                                | 正常完了は `turn/completed` の status で確定する                                                                                                                 |
| CAS-007 | `pass`    | `includeTurns: false` は成功した。ephemeral Thread の `includeTurns: true` は error `-32600` で拒否された                                                                      | persistent ThreadはCAS-008で別途検証                                                                                                                             |
| CAS-008 | `pass`    | completed Turnを持つpersistent Threadは、App Server再起動後に`thread/read(includeTurns=true)`で履歴を取得でき、`thread/resume`後に同じThreadで次のTurnを正常完了できた         | read / resumeは4回、resume後の継続Turnは1回実施                                                                                                                  |
| CAS-009 | `pass`    | assistant delta後の`turn/interrupt`は空responseを返し、その後`thread/status/changed(idle)`、`turn/completed(interrupted)`を受信した                                            | 同じprobeを2回実行し同順序。user cancelはterminal eventとの相関後に確定する                                                                                      |
| CAS-010 | `pass`    | 不一致`expectedTurnId`とterminal後のsteerは`-32600`で拒否され、一致時は同じTurn IDで受理され、persistent履歴に2件目のuserMessageとして反映された                               | 同じprobeを2回実行。拒否入力は履歴へ反映されなかった                                                                                                             |
| CAS-011 | `pass`    | command / file approvalのdeclineでは副作用がなく、acceptでは一時workspace内のmarkerだけが作成された                                                                            | request、response、`serverRequest/resolved`、item / Turn terminalの順序を確認した                                                                                |
| CAS-012 | `pass`    | permission、`request_user_input`、MCP tool approval、MCP server formは回答後にTurnを正常完了した。MCPは直接tool callとmodel Turnの両方でfixtureへの回答とtool resultを確認した | tool approvalとserver formは同じmethodを使うためmetadataの`codex_approval_kind`で区別し、各requestの`serverRequest/resolved`とMCP item / Turn terminalを確認した |
| CAS-013 | `pass`    | assistant delta受信後にstdio App Server processを強制終了すると、別processからの`thread/resume`で同じTurnが`interrupted`として取得できた                                       | 4回実施。Turnの継続と欠落deltaの再配信はなく、履歴にはuserMessageだけが残った                                                                                    |
| CAS-014 | `pass`    | exactなThread / Turn tupleごとにstartからterminalまでの区間を集計し、最大同時active数10、各start / terminal 1件、cross-owner event 0件を確認した                               | 2 Runのpending approval分離も別途2組実施。有限のprobeから絶対上限は主張しない                                                                                    |
| CAS-015 | `pass`    | 未知notificationと後続terminalをsynthetic streamへ注入し、停止せず順序を保持した                                                                                               | public diagnostic projectionは未知method / payloadを含めず固定`other`へ縮退した                                                                                  |
| CAS-016 | `pass`    | Lunaの3 Turnすべてでcompleted agentMessageが`commentary` 1件、`final_answer` 1件、`null` 0件だった                                                                             | stable schemaは`phase`をoptional / nullableとしており、`null` fallbackを引き続き要求する                                                                         |
| CAS-017 | `blocked` | `codex-cli 0.145.0`と`0.146.0`でWindowsのdaemon lifecycleは非対応だった                                                                                                         | 既存daemonのinstall、start、stop、restart、設定変更は行っていない                                                                                                |

## 基本通信で観測した順序

payload は省略し、ID と path を置換している。

```text
client -> initialize
server -> initialize result
client -> initialized
client -> model/list
server -> model/list result

client -> thread/start (ephemeral, read-only, approval=never)
server -> thread/start result (status=idle)
server -> thread/started

client -> turn/start
server -> turn/start result (status=inProgress)
server -> thread/status/changed (active)
server -> turn/started (inProgress)
server -> item/started (userMessage)
server -> item/completed (userMessage)
server -> item/started (agentMessage)
server -> item/agentMessage/delta ...
server -> item/completed (agentMessage)
server -> thread/status/changed (idle)
server -> turn/completed (completed)
```

## Thread 読取で確認した制約

```text
thread/read(includeTurns=true)
-> error -32600: ephemeral threads do not support includeTurns

thread/read(includeTurns=false)
-> success, thread.status=idle, thread.turns=[]
```

ephemeral Thread は transport の smoke test には適するが、履歴復元の検証には使えない。永続 Thread の再開・履歴読取は別の検証項目として扱う。

## Persistent Thread復旧で確認した挙動

検証には`docs/investigations/codex-app-server/recovery-probe.mjs`を使用し、同じ2ケースを4回実行した。read / resumeとactive Turn異常終了の結果はすべて一致し、4回目はresume後の継続Turnも確認した。

### completed Turnの再開

```text
process A -> thread/start (persistent)
process A -> turn/start
process A <- turn/completed (completed)
process A -> exit

process B -> thread/read(includeTurns=true)
process B <- thread.status=notLoaded, turns=[completed]
process B -> thread/resume
process B <- thread.status=idle, turns=[completed]
process B -> turn/start
process B <- turn/completed (completed)
```

`thread/read`はThreadをloadしていない状態でも永続履歴を返した。`thread/resume`後は同じThread IDとcompleted Turnを保ち、2回目のTurnを正常完了して会話を継続できる。

### active Turn中のApp Server異常終了

```text
process A -> thread/start (persistent)
process A -> turn/start
process A <- turn/started (inProgress)
process A <- item/agentMessage/delta
process A -> force exit

process B -> thread/resume
process B <- thread.status=idle, turns=[interrupted]
```

再開したTurnは`interrupted`であり、同じTurnの実行継続や未受信eventの再配信は観測しなかった。切断前にassistant deltaを受信していても、再開したTurnのitemsは`userMessage`だけで、partial `agentMessage`はProvider履歴から復元できなかった。

この実測はstdio transportでApp Server process tree全体を終了した場合の結果である。常駐daemonへ別clientが再接続する場合や、App Serverを残したclient-only切断は未検証とする。

## interruptで観測した順序

`docs/investigations/codex-app-server/runtime-contract-probe.mjs`を同じ条件で2回実行し、どちらも次の順序だった。request / response ID、Thread / Turn ID、delta本文は記録していない。

```text
client -> turn/interrupt
server -> turn/interrupt response ({})
server -> thread/status/changed (idle)
server -> turn/completed (interrupted)
```

interrupt responseはterminal notificationより先に届いた。したがってresponse成功だけでRunを`canceled`へ進めず、durableなuser cancel requestと`turn/completed(interrupted)`を相関して初めて`canceled`を確定する。terminal notificationを受け取れないresponse loss、transport failure、process failureは`interrupted`として照合する。

## steerで観測した受理・拒否・履歴

同じactive Turnへ次の順でrequestを送り、2回とも同じ結果だった。

```text
turn/steer(expectedTurnId=<mismatch>)
-> error -32600 (expected active Turn mismatch)

turn/steer(expectedTurnId=<active-turn-id>)
-> success (turnId=<same-active-turn-id>)
-> turn/completed (completed)
-> thread/read(includeTurns=true): userMessage 2件

turn/steer(expectedTurnId=<completed-turn-id>)
-> error -32600 (no active turn)
```

一致requestのsupplemental本文は同じTurnの2件目のuserMessageとしてpersistent履歴へ反映された。不一致とterminal後の入力は反映されなかった。Adapterはactive Run / RunAttempt / ProviderBinding / Turnのtupleを確認してから`expectedTurnId`を送り、拒否や受理不明のMessageを後続Runへ暗黙転用しない。

## assistant phaseで観測した分類

toolを使わずcommentary 1件とfinal answer 1件を要求した。2回ともcompleted agentMessageは次の構成になった。

```text
commentary: 1
final_answer: 1
null: 0
unexpected: 0
turn/completed: completed
```

期待したfinal本文は`phase=final_answer` itemにだけ存在したため、successful Turnのfinal Messageは明示的final candidateから確定できる。`codex-cli 0.144.6`のstable schemaはphaseをnullableとし、Providerが一貫してphaseを返さない場合は`null`をunknownとして互換処理するよう記載している。今回`null`を観測しなかったことを理由にfallback契約を削除しない。

## Approvalと追加入力で観測した順序

`docs/investigations/codex-app-server/interaction-contract-probe.mjs`は、既存hooksとMCP serverを無効化したeffective configを確認してから実行した。live実測時にはprobe終了時の一時workspace sentinel不変とcleanup完了を確認した。

live実測の10 Turnを使い切った後のcontract reviewでは、form先行や未知discriminator、failed Turn、対象itemの非completed terminal、fixture eventの不足・余分、discovery用App ServerまたはMCP fixture processの回収失敗を成功扱いできる余地を確認した。probeはこれらを`blocked`とし、全case、transport、cleanupが成功した場合だけtop-level `status=pass`を返すように強化した。Windows processは起動指示待ちsupervisorをJob Objectへ割り当ててからCodexを起動し、audit PIDの再探索による終了を廃止した。Linuxでは`Delegate=yes`、`KillMode=control-group`の一時systemd user serviceを作り、専用cgroup v2の`cgroup.kill`を開いてからCodexを起動する。親はPIDやprocess groupを再探索せず、保持済みcgroup handleから同じtreeだけを終了する。`cgroup.kill` writeを意図的に失敗させたcaseでは、probe自身のreleaseが所有権を検証したexact unitへ`systemctl --user stop`を行い、外側cleanupへ進む前にwrapper、supervisor、subject、descendantの終了とunitのinactiveまたは不存在を確認した。systemd user managerまたはdelegated cgroup v2を利用できないPOSIXはsubject spawn前に拒否する。process treeを使うself-testでは通常回収、Job close / cgroup release fallback、Job assignment失敗後のowned supervisor回収、Linuxのdelegated cgroup open失敗とcgroup handle取得後かつsubject launch前の失敗からのunit回収を確認した。短縮watchdogではprimary terminationとreleaseを両方意図的に失敗させ、終了コード124へ収束した後にwrapper、supervisor、subject、descendantがすべて消滅することを外側processから確認した。Linuxでは監査済みの正確なunit identityで外側cleanupを行い、unitのinactiveまたは不存在も確認した。App Server preflightでは設定隔離と`cleanup=verified`を確認した。Linux固有caseでは、subject先行、内側supervisor先行、`systemd-run` wrapper先行、App Server client停止中のwrapper先行、短命subject終了後のprocess churnを注入し、owned descendantの回収と無関係guard processへの非干渉をWSL2 Ubuntu上のNode.js 24.18.0で確認した。
App Server JSONLはnewline前から1行256 KiBをbyte単位で制限し、4,096件、UTF-8合計4 MiBのいずれかを超えた時点で単調なtransport failureへ固定する。buffer済みeventに一致するwait、既存・後続waiter、pending requestに加え、正常responseと同じchunkの後続overflowで停止済みdiscovery clientをcleanup ownerから外した場合も、別のtransport履歴によりtop-level statusが成功へ戻らない反例をself-testした。MCP fixture auditはprocess再起動をまたぐ共有file全体をwriter / readerの双方で64件、64 KiBへ制限し、未知recordを固定`other`へ写像してexact lifecycleを不成立にする。stdoutのitem観測は通常経路とmissing-terminal診断の両方でallowlist化したtype / status別件数へ集約し、terminal / prewarm statusもallowlist化した。payload mismatch診断はbooleanと件数だけに限定し、Provider item ID、未知key / action type、未知Provider statusを除去した。MCP formはtool approval resolved前のformに加え、terminalまでの別kind、owner表現が異なるMCP request、追加・再配送request、duplicate resolvedをsynthetic counterexampleで拒否する。file change projectionはworkspace相対の安全なslash区切りpathと既知change kindだけを回答可能とし、C0 / C1制御文字とbidi controlも拒否する。
Windowsは39 case、Linuxは46 caseを通過し、Linux self-test後に`withmate-probe-*.service`が残らないことを確認した。public interactionのdynamic response、prototype由来key、Unicode code point境界、上限超過projectionはnegative / boundary self-test、static schemaはDraft 2020-12 validatorのcompileとsafe relative path、absolute POSIX / Windows path、parent-relative、backslash、NUL、LF、C1制御文字、bidi control、未知change kind、matching responseの12 instanceで確認した。この時点では強化後のlive Turnを再実行していなかったが、2026-08-01の追加実測で後述する経路を再確認した。

Linux live probeでは、subject起動後に`cgroup.kill`とexact unitへのrelease fallbackが両方失敗した場合、`cleanup=failed`と非0終了する一方、probe単体ではunitまたはdescendantの不残存を保証できない。self-testは外側processがexact unitを回収してこの反例を閉じているが、通常のlive実行には同じ外側ownerがない。通常cleanup failureとhard watchdogは、probe生成規則へ一致したexact systemd user unitだけをboundedな`cleanupRecovery[]`へ投影する。`CP3-APP-SERVER-R1`として、失敗時はこの`unitName`を停止してinactiveまたは不存在まで確認し、Linux liveをrelease Gateへ含める前に外側cleanup wrapperを追加する。

command / file approvalのacceptとdeclineは次の順序で完了した。

```text
server -> interaction request
client -> response
server -> serverRequest/resolved
server -> item/completed
server -> turn/completed (completed)
```

command / fileのdeclineではmarkerを作成せず、acceptでは一時workspace内のmarkerだけを作成した。さらにcommand declineの`serverRequest/resolved`後に同じrequest IDへresponseを再送したところ、resolved、item terminal、Turn terminalは各1件、副作用とerror notificationは0件だった。server responseにはresponse ACKがなく、2回目だけの受理・拒否結果は独立に観測できない。このため、Adapter側でresolved後の再送を防止する必要がある。

permission requestを発生させるには`features.request_permissions_tool=true`とgranular approvalの`request_permissions=true`が必要だった。default modeで`request_user_input`を発生させるには`features.default_mode_request_user_input=true`が必要であり、experimental server requestを受ける接続は`initialize.capabilities.experimentalApi=true`を宣言した。featureを有効化しなかった先行probeでrequestを観測できなかった原因は、App Serverの非対応ではなくprobe設定の不足だった。

permissionと`request_user_input`はrequest payloadのThread / Turn / item ID、response、`serverRequest/resolved`、`turn/completed(completed)`を確認した。一方、`codex app-server generate-ts --experimental`で生成した`ThreadItem` unionには両method専用のitem variantがなく、実測でも同じitem IDの`item/completed`をterminal条件にできなかった。Adapterは両methodについて、owner tuple、request payload、request解決、Turn terminalを検証し、command / file approvalのitem terminal契約を流用しない。

### 2026-08-01の追加interaction実測

先行して計画した50 Turnを実行した。これは当時の検証枠であり、live検証全体の総Turn上限ではない。すべてrepository外の一時workspace、ephemeral Thread、isolated config、networkなし、persistent grantなしで実行し、各live caseのtransport終了、process tree回収、sentinel不変、temp root削除を確認した。

- permissionと`request_user_input`は専用modeで各2回、exact owner / payload、response、resolved、Turn completedを再確認した。`request_user_input`のProvider payloadにある`isOther=true`はpublic snapshotの必須boolean `allowOther=true`へ投影し、current option labelと2,048 code point以下の自由入力Otherを別々のlive Turnで回答できた。permissionを要求したpromptが`request_user_input`を選んだ2 Turnと固定commandを外したcaseはmodel tool-choiceの不一致であり、対象protocolのpassには数えていない。
- MCP model Turnはtool approval、resolved、server form、resolved、fixture response、tool result、MCP item completed、Turn completedの完全なsuffixを再確認した。fixture初期化の正規prefixは再初期化を含む1組以上の`initialized` / `tools_list`を許可するが、partial pair、未知またはinterleaveしたrecord、重複tool call、call後の余分なrecordを拒否する。
- clientのbounded wait到達時はrequestがpendingのままで、interrupt後に副作用なしで終了した。これはProvider側timeoutの存在を示さず、WithMate側の待機上限とcleanupだけを確認する。
- interaction responseと`turn/interrupt`の競合は、response先行4回、interrupt先行4回で、いずれもinteraction 1件、resolved 1件、`turn/completed(interrupted)` 1件、副作用0件へ収束した。観測結果はApplication側のdurable admissionやidempotencyを代替しないため、response admissionとcancel admissionを同じper-Run mutation ownerで直列化する契約は維持する。
- stdio切断はresponse送信直後、短い遅延後、`serverRequest/resolved`観測後に実行した。観測できた対象caseではmarker副作用はなく、切断後にitem / Turn terminalを受信できないためeffect certaintyはProvider protocolだけでは確定できない。特に`serverRequest/resolved`はinteraction解決であり、command実行完了の証拠ではない。
- 同一process上の2つのactive Runは、toolなし2組と片方がpending approvalの2組を実行した。各Runのterminalは1件、pending approvalはsibling Turnの完了中も維持され、interaction / resolvedは正しいownerだけへ相関し、cross-owner resolutionは0件だった。
- 最後の2 TurnはMCP interaction ownerのprobe条件を再検証した。requestはexactなThread / Turn IDを持つ一方、MCP tool approval自体にはitem IDがなく、対応するMCP itemの`item/started`より前にも到達できる。item IDまたは先行`item/started`をMCP requestのadmission条件にした2回はいずれもacceptを送らず安全に`blocked`となり、副作用0、transportとcleanupの完了を確認した。probeはMCP requestをexactなThread / Turnで照合し、後続のMCP item lifecycleを別事実として追跡するよう修正した。

対象itemの`item/started`を一律に必須にする旧probe条件、MCP requestへitem IDを要求する条件、permission / user inputへ専用item terminalを要求する旧条件は、生成bindingと実測contractに反するprobe側のfalse blockだった。method別owner / terminal条件へ修正し、synthetic counterexampleを含むself-testで誤受理と誤拒否を確認した。

### Lunaによる上限なし継続検証

追加live検証は総Turn上限を置かず、各invocationの最大10 Turnと14分 / 15分のdeadlineだけを安全境界として維持した。すべてのmodel Turnは`thread/start`と`turn/start`に`gpt-5.6-luna`を明示し、`turn/start.effort=high`を指定した。Turn開始前の`model/list`ではLunaの`id / model`一致、default effort `medium`、supported effort `low / medium / high / xhigh / max`を確認し、`ultra`を使用していない。

- 外部Turn 0のpreflightでは、`modelProvider/capabilities/read`が`imageGeneration / namespaceTools / webSearch`のbooleanを返すことを確認した。`model/list(includeHidden=false/true)`はvisible 7件 / 全8件、hidden 1件で、visible集合が全体の部分集合、Lunaが非hiddenであることを確認した。件数はcurrent accountの観測値であり、固定contractにはしない。
- 修正後のMCP model TurnをLunaで1回再実行し、tool approval、resolved、server form、resolved、fixture response、tool result、MCP item completed、Turn completedを最後まで確認した。旧条件修正後にlive passがなかったgapは解消した。
- resolved後の重複responseを1回実行した。request lifecycle、item、Turnは各1回だけ完了し、副作用とerror notificationはなかった。重複response固有のACKはwire上存在しないため、重複側の受理 / 拒否は観測不能と結論づけた。
- toolなしTurnの同時実行は8件、続いてinvocation上限と同じ10件で実行し、全Turnが`completed`、各`turn/started` / terminal 1件、interaction 0件、cross-owner event 0件だった。exactなThread / Turn tupleごとの開始からterminalまでを区間として集計し、10区間すべてがterminal前に開始済みとなる最大同時active数10を確認した。10は実測下限であり、account、model、server resourceに依存する絶対上限ではない。
- assistant phaseは3 Turnすべてで`commentary` 1件、`final_answer` 1件、`null` 0件だった。生成schemaではagentMessageの`phase`自体がoptionalかつnullableであるため、未観測を理由にfallbackを削除しない。
- unknown notificationはexternal Turn 0のsynthetic client self-testで、後続terminalを停止させず、public diagnostic projectionをraw method / payloadを含まない固定`other`へ縮退することを確認した。受信時の内部bufferにraw wire messageが存在しないことまでは検証していない。

最初の継続検証は23 Turnだった。contract review後のclosureではさらに74 Turnを実行し、Luna / `high`の継続検証を少なくとも97 Turnまで進めた。closureではoptionと自由入力Otherの両回答、command / fileのaccept / decline、permission、通常時とprewarm後のMCP二段round trip、resolved後duplicate、assistant phase、2件と10件の並行実行、pending interactionのsibling分離、response / interruptの両順序、response直後・遅延後・resolved後のstdio切断を再実測した。terminalは全経路でexactなThread / Turn tupleへ相関した。probe実装不備で安全にblockedとなった10 Turnと、model tool-choice不一致でblockedとなった4 Turnもこの97 Turnへ含むが、protocolのpass根拠には数えていない。external Turn 0のdirect MCPは、tool call response直後のfixture監査書込みをboundedに待って完全suffixを確認した。各invocationは終了時にtransport、process tree、sentinel、temp root cleanupを`verified`とした。

最終deltaでは、error pathに残っていた4か所のterminal waitをexact Thread / Turn tupleへ揃えた後、さらに38 Turnを`gpt-5.6-luna` / `high`で実行した。MCP二段round trip 1 Turn、optionと自由入力Other 2 Turn、10並行Turn、response / interruptの両順序8 Turn、command / fileのaccept / decline 4 Turn、assistant phase 3 Turn、permission / user input / MCP follow-up 3 Turnはinvocation単位でpassした。direct MCPもexternal Turn 0で完全fixture suffixを確認した。raceの先行2 invocationとresolved後disconnectの1 invocationでは、固定commandを選ばないmodel tool-choice mismatchが合計3 Turnあり、acceptを送らずoverall `blocked`へ閉じた。これらはprotocolのpass根拠に数えていない。全invocationでtransportとcleanupを`verified`とした。

共有model preflightとprocess ownerへ収束する直前には、さらに36 Turnを`gpt-5.6-luna` / `high`で実行した。MCP二段round trip 1 Turn、optionと自由入力Other 2 Turn、10並行Turn、response / interruptの両順序8 Turnとinterrupt先行の追加3 Turn、command / fileのaccept / decline 4 Turn、resolved後disconnect 2 Turn、assistant phase 3 Turn、permission / user input / MCP follow-up 3 Turnがpassした。model tool-choice mismatchはなく、全invocationでtransportとcleanupを`verified`とした。

最終sourceでは、3本に分散していたcapability / catalog / Luna tuple検証を共有preflightへ、process treeの起動・終了・回収確認を共有ownerへ移した。Windowsは起動待ちsupervisorをkill-on-close Job Objectへ割り当てた後にCodexを起動し、controller先行終了でもJobのterminate / releaseとcontroller / supervisor / subjectの不在確認を省略しない。通常回収、Job assignment失敗、controller先行、cleanup failure、temp削除順を実process self-testで確認した。3本の外部Turn 0 preflightはvisible 7件 / hidden込み8件、hidden 1件、Luna visible、`high` advertise済み、transportとowner cleanup成功を再確認した。

共有preflight / process ownerへ収束した時点のsourceに対して、App Server内で40 Turnを`gpt-5.6-luna` / `high`に明示して実行した。runtime contract 3 Turn、completed resume / active disconnect recovery 3 Turn、interaction 34 Turnである。interactionではMCP二段round trip 1 Turn、optionと自由入力Other 2 Turn、10並行Turn、response先行4 Turn、interrupt先行4 Turn、command / fileのaccept / decline 4 Turn、resolved後disconnect 2 Turn、assistant phase 3 Turn、permission / user input / MCP follow-up 3 Turnが対象contractをpassした。raceの途中1 Turnは固定commandを選ばないmodel tool-choice mismatchであり、acceptを送らず副作用0、transport / cleanup `verified`でoverall `blocked`へ閉じたため、protocolのpass根拠には数えていない。external Turn 0のdirect MCPも完全fixture suffixまでpassした。recoveryはmodel preflight 3回と実Turn 3回が一致し、cleanupを`verified`とした。runtimeは各caseのowner cleanupとtemp削除が成功した後だけreportを書き出し、3 caseすべてがpassした。`ultra`は使用していない。

その後の独立reviewで、共有preflightがcatalog entryの`hidden`、default effort、visible / complete集合の完全一致を厳密に検証していないこと、runtime / recovery probeがprocess ownerの起動待ちとprobe全体へdeadlineを適用していないこと、recovery probeが取得したThread / Turn statusをreportへ記録するだけで契約としてassertしていないことを確認した。共有preflightをexact validationへ変更し、malformed `hidden` / default、unsupported default、`high`欠落、complete集合だけに現れる非hidden modelを拒否する独立self-testを追加した。process ownerの起動待ち、main 14分、cleanupを含むtotal 15分のdeadlineとhard watchdogをruntime / recoveryへ適用し、起動指示前で停止する実process self-testがowner treeを回収することを確認した。recoveryはcompleted readの`notLoaded`、resume後の`idle`、completed / interrupted Turn、exactなThread / Turn履歴を機械assertする。

review修正後にはさらに76 Turnを実行した。このうち、現行contractを最後までpassしたinvocationはruntime 9 Turn、recovery 12 Turn、interaction 36 Turnの計57 Turnである。interactionはMCP二段round trip、optionと自由入力Other、10並行、response / interruptの両順序、command / file、resolved後disconnect、assistant phase、permission / user input / MCP follow-upを再確認した。残る19 Turnは、修正途中のrecovery probeがcompleted readへ誤って`idle`を要求した2 invocation 6 Turnと、固定commandを選ばないmodel tool-choice mismatchでrace probeが安全に`blocked`となった2 invocation 13 Turnであり、protocolのpass根拠には数えていない。誤ったstatus期待は既存実測どおり`notLoaded`へ修正し、raceはacceptを送らず副作用0、cleanup `verified`で閉じ、再実行した8 caseはすべてpassした。

後続のtargeted reviewでは、recovery履歴が期待Turnに加えて別のTurnを含む場合も受理できたことと、runtime / recoveryのtemp削除が同期APIのためtotal watchdogをblockできたことを確認した。履歴は期待Turnだけのexact 1件を要求し、extra Turnを拒否するself-testを追加した。temp削除はprocess tree回収を確認した後に非同期実行し、remaining total deadlineで打ち切る。さらに、削除waitだけがtimeoutして未収束filesystem I/Oが残る間もowner数だけでhard watchdogを解除できたため、deadline確認後に削除を開始するthunk、未収束deadline operationの追跡、absolute total deadlineを追加した。ownerが0件で削除I/Oだけが残る外側process self-testは、短縮watchdogで終了コード124となりpassを出力しない。各修正後のrecovery 3 Turnと、cleanup変更ごとのruntime / recovery各3 Turnを再実測し、status、preflight回数、process tree回収、temp削除までpassした。全76 Turnは`gpt-5.6-luna` / `high`を明示し、`ultra`を使用していない。

fresh-context complete-diff reviewでは、不一致の`item/tool/requestUserInput`へ`decline`を指定してもprobeが回答payloadを生成し、実際にはresponseを送った経路を`not_sent` / 副作用なしと記録できることをblockingと判定した。fail-closed処理をmethod別のresponse可否と実測lifecycleを所有する共有境界へ集約した。command / file / permission / MCPはprotocol-safeなdeclineだけを送り、user inputは回答を送らずexactなThread / Turnをinterruptする。5 target methodのwrong-kind / invalid-payload matrix、secret user inputでresponse 0件かつinterrupt 1件となるnegative self-testを追加した。修正後はLuna / `high`で9 Turnを追加実測し、permission、user input、MCP二段階、command / fileの8 Turnがpassした。残るcommand 1 Turnはmodel tool-choice mismatchを安全にdeclineし、`responseDisposition=sent`、resolved、terminal、副作用0と記録してoverall `blocked`へ閉じた。review修正後の累計は85 Turnで、65 Turnをpass根拠へ採用し、修正途中またはmodel tool-choice mismatchの20 Turnを除外した。全invocationでtransport / cleanupを`verified`とし、`ultra`は使用していない。

## MCP tool approvalとserver elicitationで分離した契約

MCP elicitationは、interaction requestの解決とmodel Turnの再開を別々に検証した。

直接`mcpServer/tool/call`を呼び出すケースでは、次の全段階を確認した。

```text
fixture <- tools/call
fixture -> elicitation/create
app-server -> mcpServer/elicitation/request
client -> accept response
app-server -> serverRequest/resolved
fixture <- elicitation response
fixture -> tool result
client <- mcpServer/tool/call response
```

model Turnでは、fixtureのserver formより前にMCP tool approvalが同じ`mcpServer/elicitation/request`で届いた。先行probeはこれをserver formとして検証してdeclineしたため、fixtureへ`tools/call`が届かずTurnが停止していた。metadataの`codex_approval_kind="mcp_tool_call"`をdiscriminatorとして別interactionへ分けると、次の順序で完了した。

```text
app-server -> mcpServer/elicitation/request (MCP tool approval)
client -> accept response (content={}, persistent choiceなし)
app-server -> serverRequest/resolved
fixture <- tools/call
fixture -> elicitation/create
app-server -> mcpServer/elicitation/request (server form)
client -> accept response (content={choice: ...})
app-server -> serverRequest/resolved
fixture <- elicitation response
fixture -> tool result
app-server -> item/completed (mcpToolCall, completed)
app-server -> turn/completed (completed)
```

tool approval metadataの`persist`はsession / alwaysの選択肢を広告しうるが、probeは永続choiceを返さず、空contentのplain acceptだけを送った。stable protocolのmetadata fieldは`_meta`であり、`codex-cli 0.145.0`のlive probeでは同じmetadataが`meta`として届いた。実測したtool approval metadataには`tool_name`がなく、fixtureが固定した`tool_description`と空の`tool_params`が届いた。probeは隔離済みserver名、`tool_name`があれば固定名、なければ固定description、固定引数、空form schemaを組み合わせて対象を照合した。

Codex Adapterは同じwire methodを一つのpublic kindへ潰さず、MCP tool approvalとMCP server elicitationを別variantへ投影する。`codex_approval_kind`がなく`mode=form`の場合だけserver formとし、未知discriminatorまたは非form modeを回答対象へ投影しない。各requestの`serverRequest/resolved`はpending requestの解消として追跡し、tool round trip完了はfixture resultに対応する`item/completed(completed)`、Turn完了は`turn/completed(completed)`で別々に確定する。

## daemon client-only再接続のblocked判定

`codex app-server daemon version`は`codex-cli 0.144.6`と`0.145.0` on Windowsの両方で、daemon lifecycleはUnix platformだけが対応するとして終了した。既存環境を変更せず隔離したdaemonを開始できないため、CAS-017は`blocked`とした。

stdioはdefault transportであり、`0.145.0`のCLI helpはUnix socket、WebSocket endpointと認証optionも広告する。一方、Windowsではmanaged daemon lifecycleを実測できず、WebSocketも初期CP3のaccepted transportではない。よって初期CP3ではCodex daemonへ依存せず、WithMate runtime hostがstdio App Server childを所有する。CLI client-only切断はWithMate local IPC境界で検証し、Provider接続を切断しない。

## 設計への影響

### 2026-08-02 vertical slice closure再実測

- App Server内のmodelは全live Turnで`gpt-5.6-luna`、reasoning effort `high`を明示し、`ultra`を使用しなかった。preflightではLunaがvisibleであること、supported effortが`low` / `medium` / `high` / `xhigh` / `max`であること、Provider capabilityとhidden込みcatalogの整合を確認した。
- runtime 3 Turn、recovery 3 Turn、interaction 56 Turnの計62 Turnを実行した。60 Turnを対象contractのpass根拠へ採用し、固定commandと意味は一致するがLunaが別のPowerShell表記を選んだrace 2 Turnはacceptを送らず、安全なdecline、resolved、terminal、副作用0、cleanup `verified`へ閉じた。別invocationではresponse先行4回とinterrupt先行6回がすべてpassしており、両順序のcontractを再確認できた。
- command / file、permission、option / Other、MCP directとtool approval→formの二段round trip、送信直後・遅延後・resolved後のstdio切断、resolved後duplicate、2 Runのpending owner分離、10同時Turn、assistant phaseを再実測した。各pass invocationでtransport、process tree、sentinel、temp root cleanupを`verified`とした。
- runtimeはinterrupt、steer、assistant phase、recoveryはcompleted Threadのread / resume / 継続Turnとactive Turn切断後の`interrupted`収束を再確認した。CAS-017のWindows daemon lifecycleだけは引き続き`blocked`であり、採用するstdio child ownershipの実装範囲外とする。

### 2026-08-02 capability admission closure再実測

- command approvalのcurrent `availableDecisions`と、model / reasoning capabilityのdurable Run admission前検証をsourceとexecutable contractへ追加した後、exact `codex-cli 0.145.0`をPATH先頭へ置いて再実測した。App Server内の全live Turnは`gpt-5.6-luna`、reasoning effort `high`を明示し、`ultra`を使用していない。外部Turn 0のpreflightでProvider capability、visible / hidden catalog、Lunaとsupported effort `low` / `medium` / `high` / `xhigh` / `max`の組を再確認した。
- runtime 3 Turn、recovery 3 Turn、interaction 50 Turnの計56 Turnを実行した。54 Turnを対象contractのpass根拠へ採用した。残るpermission 2 Turnは、`request_permissions`を指定したLunaが`item/tool/requestUserInput`を選んだtool-choice不一致であり、responseを送らずexact Turnをinterruptし、terminal `interrupted`、pending 0、副作用0へ安全に閉じた。permission round trip自体は別の2 Turnでpassしている。
- interactionはcommand / fileのaccept / decline、permission、option / Other、MCP tool approvalからserver formまでの二段round trip、response / interruptの両順序各4回、10同時Turn、resolved後duplicate、送信直後・25 ms・250 ms・resolved後のstdio切断、2 Runのpending owner分離、assistant phaseを再確認した。runtimeはinterrupt、steer、assistant phase、recoveryはcompleted Threadのread / resume / 継続Turnとactive Turn切断後の`interrupted`収束をpassした。
- 各probe invocationはtransport、App Server process tree、probe workspace、sentinel、probe temp rootのcleanupを`verified`とした。検証のためsession-localへ隔離配置したCLI runtime directoryは、全probe終了後の削除commandが実行環境のpolicyで拒否され、削除処理は開始されなかった。製品workspace、repository、App Server processには残存を確認していない。

### 2026-08-02 inherited retry Binding closure再実測

- retryがsource Runのmodelを`inherited`として継承し、再利用可能なactive Bindingがない場合も、同じprovenanceを`thread/start`まで伝搬するようAdapter contractを閉じた。`explicit`はcatalog上の`selectable`を要求し、`inherited`は新規選択ではないためhidden historyを許可するが、catalog上の存在、text input modality、reasoning effortは同じruntime generationで検証する。`modelSelection`はApp Server wireへ送信しない。
- coldなmodel catalog loadはruntime generationが所有し、最初のpreflight callerの中断で共有loadや兄弟preflightを失敗させない。explicit hiddenはProvider mutation 0、inherited hiddenのThread開始、unsupported effort / modalityのProvider mutation 0、runtimeのcreating Bindingへのprovenance伝搬をexecutable contractで確認した。
- Node.js 24.18.0で対象171 test、全1067 test、SQLite schema validator、runtime guard、format、module boundary / lint、typecheck、build、8 process smoke、model preflight / interaction / runtime / recovery probe self-test、diff checkを通した。全testとbuildを同時実行した最初の試行では、25 ms再試行中の未完了状態を壁時計で判定するtestが1件Redとなった。2回目の永続化呼出しを明示gateで停止する決定的なcontractへ変更し、対象test 12回と全1067 testの再実行をGreenとした。
- exact `codex-cli 0.145.0`を起動し、App Server内で`gpt-5.6-luna` / `high`を明示してruntime 3 Turnとrecovery 3 Turnを追加実測した。Turn開始前のpreflightは外部Turn 0でLunaのvisible catalog entry、supported effort `low` / `medium` / `high` / `xhigh` / `max`、Provider capability、hidden込みcatalogを確認した。6 Turnはすべてpassし、transport、process tree、probe workspace、temp root cleanupを`verified`とした。Lunaはvisible modelであるためhidden historyの`thread/start`経路自体はlive Turnで直接実測せず、Provider contract testとfake transportで検証した。`ultra`は使用していない。

### 2026-08-02 release非依存Decoder closure再実測

- 通常PATH上の`codex-cli 0.146.0`をそのまま起動し、生成schema baseline `0.145.0`との差をadmission gateにせず、実payloadのDecoderとruntime contractで互換性を判定した。App Server内のmodelは全live Turnで`gpt-5.6-luna`、reasoning effort `high`を明示し、`ultra`を使用していない。各invocationのTurn開始前にProvider capability、visible / hidden catalog、Lunaとsupported effort `low` / `medium` / `high` / `xhigh` / `max`を再確認した。
- runtime 3 Turn、recovery 3 Turn、interaction 62 Turnの計68 Turnを実行し、64 Turnを直接pass根拠へ採用した。残る4 Turnは、Lunaが固定commandを意味の近い別表記にした3件と、permission指定時にuser inputを選んだ1件である。いずれもtarget mismatchとしてacceptを送らず、declineまたはinterrupt、resolved / terminal、pending 0、副作用0、cleanup `verified`へ閉じた。command / fileのaccept / decline、permission 2回、option / Other user input、response先行 / interrupt先行の両raceは別invocationで全件passしている。
- command / file、permission、user input、MCP directとtool approvalからformまでの二段round trip、送信直後・25 ms・250 ms・resolved後のstdio切断、response / interrupt race、resolved後duplicate、2 Runのpending owner分離、10同時Turn、assistant phaseを再実測した。runtimeはinterrupt、steer、assistant phase、recoveryはcompleted Threadのread / resume / 継続Turnとactive Turn切断後の`interrupted`収束をpassした。全invocationでtransport、process tree、probe workspace、sentinel、temp root cleanupを`verified`とした。
- interaction probe自身のversion gateも廃止し、実CLI identityとschema baselineを別fieldへ記録する。probe self-test、model preflight negative contract、runtime / recovery / interaction preflightは`0.146.0`でpassした。CAS-017のWindows daemon lifecycleだけは引き続き`blocked`であり、stdio child ownershipを採用する実装scope外である。

### 確定できた判断

- stdio / JSONL を Codex Adapter の第一 transport として採用できる。
- `codex-cli 0.144.6`でもstable schemaの`turn/steer`、`turn/interrupt`、agentMessage phase契約を確認した。
- Thread ID、Turn ID、item ID を WithMate Session / Run / event と対応付けられる。
- streaming assistant message は delta の順序を保って構築できる。
- `thread/status/changed(idle)` ではなく `turn/completed` の status を Run terminal 判定に使う。
- model catalog は App Server から取得できる。
- `modelProvider/capabilities/read`と`model/list(includeHidden=false/true)`を、model pickerとfeature gateのcurrent runtime evidenceに使える。Luna / `high`の組はTurn開始前にadvertise済みであることを確認できた。
- Thread mode は ephemeral / persistent を明示的に区別する必要がある。
- completed persistent Turnはprocess再起動後にread / resumeできる。
- stdio App Server processの異常終了時、active Turnは`interrupted`へ収束し、同一Turnの監視再開はできない。
- 切断前に受信した未確定assistant deltaはProvider履歴から復元できない。streaming deltaを永続化しない現行方針では、App Server crash時の未確定draft消失を許容し、復旧時に推測でpartial outputを生成しない。
- interrupt responseはterminal確定ではなく、user cancelと`turn/completed(interrupted)`の相関が必要である。
- steerはactive Turn IDの一致をpreconditionとし、同じTurnのsupplemental user Messageとして履歴へ反映される。拒否と受理不明を後続Runへ転用しない。
- Lunaでもexplicit `final_answer`はsuccessful Turnのfinal candidate、`commentary`はassistant detailに分類できる。nullable phaseのfallbackは引き続き必要である。
- 初期CP3はCodex managed daemonを使わず、長寿命WithMate runtime hostがstdio App Server childを所有する。CLI終了はProvider disconnectやRun cancelを意味しない。
- command / file approval、turn-scoped permission、`request_user_input`はserver request、WithMate response、`serverRequest/resolved`、Turn terminalを分離して管理できる。command / fileだけは対応するitem terminalも別に追跡する。
- `request_permissions`とdefault modeの`request_user_input`はfeature gateを持つ。Codex definitionはinitialize capability、feature、approval policy、実payloadの組を検証し、利用可能なinteractionだけを公開する必要がある。CLI release文字列はfeature availabilityの代用にしない。
- MCP tool approvalとMCP server elicitationは同じwire methodでも別interaction kindとして扱う。tool approval、server form、fixture result、MCP item、Turnの全段階をmodel Turnで完了できる。
- `serverRequest/resolved`はpending requestの解消またはcleanupを示す。Provider tool result、item terminal、Turn terminalの代用にはならない。
- Codex初期definitionのpublic interaction kind、snapshot / response shape、静的上限は`schema/providers/codex/interaction-v1.schema.json`で固定する。dynamicなquestion / field ID、option membershipまたは`allowOther=true`のbounded自由入力、requiredness、field固有上限、current owner、回答可否はruntime validatorでsnapshotと再照合する。MCP formのacceptはvaluesをProvider contentへ変換し、decline / cancelは値を持たない別shapeとする。回答判断へ必要なcontentを上限内へ完全に投影できないrequestはtruncateせずunavailableとする。
- permissionとuser inputはrequestのitem IDをowner tupleへ含めるが、専用の`ThreadItem` terminalを持たない。MCP interaction requestはexactなThread / Turn IDを持つがitem IDを持たず、後続のMCP item lifecycleとは別に相関する。いずれもrequest解決とTurn terminalを別々に追跡し、存在しないrequest固有item terminalを待たない。
- 同一App Server process上で`turn/started`からterminalまでの区間が重なる最大同時active数10を確認し、10件のactive Runをowner分離できた。初期実装でもThread / Turnと、methodが提供する場合のitem IDを一つのpending ownerとして扱い、methodまたはrequest IDだけでRunを選ばない。
- response / cancelの両順序は副作用なしのinterruptedへ収束したが、Application側のdurable admissionは別契約である。response admissionとcancel admissionを同じper-Run mutation ownerで直列化する。
- 未知notificationはpublic diagnostic projectionへraw method / payloadを含めず固定`other`へ縮退し、後続の既知event処理を継続できる。受信時の内部bufferにraw wire messageが存在しないことは別契約である。

### App Server protocolだけでは確定しない境界

- Provider側timeoutを通知するstable eventや保証は確認できない。WithMateがclient wait deadlineを所有し、期限後はpending handleを閉じる。
- server request responseには独立ACKがない。resolved後の重複response固有の受理 / 拒否をwireから判定せず、WithMateがidempotencyとpending ownerで再送を防止する。
- 最大同時active数10を実測したが、account、model、server resourceに依存する絶対上限は有限のprobeから確定できない。runtime hostがより低い明示上限とbackpressureを所有する。
- response write後またはresolved後のtransport切断でterminal eventを失うと、Provider副作用の確定手段はない。`write_attempted`後は`ambiguous`として自動再送しない。
- runtime host local IPCのversion negotiation、owner確認、stale endpoint、subscription backpressureはApp ServerではなくWithMate control planeの実装契約である。

## 残リスク

- schemaとruntime contractはCodex CLI releaseにより変化しうる。起動時にCLI identityを診断へ記録し、stable protocol Decoder、operation error、connection failure、cleanupの契約testをGateにする。version文字列だけでは実行を拒否しない。
- CAS-010は履歴反映を確認するためpersistent Threadを作る。repository外workspaceの削除後もsyntheticなThreadが設定済みCodex profileへ残る可能性があり、Thread一覧から検知して不要ならarchiveできる。probeは既存Threadを変更せず、Thread IDと本文を証跡へ出力しない。
- CAS-017はWindowsのdaemon lifecycle非対応によりblockedである。採用modelはdaemonを使わず、runtime hostへのclient再接続を後続process testで検証する。
- MCP tool approvalとserver elicitationは同じmethodを使う。metadataの`codex_approval_kind`を無視すると誤ったresponse shapeを返すため、Provider definition versionごとのdiscriminator、payload validator、round-trip regression probeをGateにする。stable protocolの`_meta`とliveで観測した`meta` aliasは同じ意味へ正規化する。
- duplicate responseの独立ACKと、切断後の副作用照合はprotocolに存在しない。WithMate側のidempotency admission、pending owner確認、`write_attempted`後の`ambiguous`収束をexecutable contractで固定し、Provider responseを自動再送しない。
- `phase=null`はstable schemaでacceptedだが、Lunaの3 Turnでは観測していない。fallbackはexecutable mapper contractで固定する必要がある。
- local user configuration による hook / MCP notification も同じ stream に流れるため、Adapter は既知の主要 event だけを前提に停止してはならない。
- runtime / recovery調査probeは`readline`が改行を返した後にline / event上限を適用するため、改行なしのApp Server出力を事前byte上限で閉じない。production Adapterの契約ではなく隔離probeだけのaccepted riskとし、unattended CIまたはrelease Gateへ含める前にinteraction probeと同じnewline前byte上限を持つdecoderへ置き換える。

## 参照

- `docs/investigations/codex-app-server/runtime-contract-probe.mjs`
- `docs/investigations/codex-app-server/recovery-probe.mjs`
- `docs/investigations/codex-app-server/interaction-contract-probe.mjs`
- `docs/investigations/codex-app-server/validation-model-preflight.mjs`
- `docs/investigations/codex-app-server/probe-process-owner.mjs`
- [Codex manual](https://developers.openai.com/codex/codex-manual.md)
- [Codex App Server (`rust-v0.145.0`)](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server/README.md)
- [Codex App Server MCP server elicitations (`rust-v0.145.0`)](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server/README.md#mcp-server-elicitations)
- [Codex App Server MCP elicitation integration test (`rust-v0.145.0`)](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server/tests/suite/v2/mcp_server_elicitation.rs)
