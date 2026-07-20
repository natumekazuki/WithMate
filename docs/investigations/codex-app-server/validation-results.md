# Codex App Server Validation Results

- 実施日: 2026-07-10、2026-07-12、2026-07-20
- 状態: 基本通信、persistent Thread復旧、interrupt、steer、assistant phaseを実施済み。daemon client-only再接続はplatform制約でblocked
- 検証計画: `docs/investigations/codex-app-server/validation-plan.md`
- 関連設計: `docs/design/provider-integration.md`, `docs/design/codex-app-server-adapter-contract.md`

## 実行環境

| 検証セット | OS / runtime | Codex CLI | Transport | 条件 |
| --- | --- | --- | --- | --- |
| 基本通信、persistent Thread復旧 | Windows 10.0.26200, x86_64 | `0.144.1` | stdio JSONL | repository外workspace、ephemeral / persistent、read-only、approval=never |
| runtime contract再実測 | Windows 10.0.26200, x86_64 / Node.js `24.18.0` | `0.144.6` | stdio JSONL | repository外workspace、ephemeral / persistent、read-only、approval=never |

2026-07-20の既定shellはNode.js `22.22.1`だったため、repository要件を満たすinstalled Node.js `24.18.0`の実体を明示してprobeを2回実行した。Codex CLIはPATH上の`0.144.6`を使用した。

## schema 調査

`codex-cli 0.144.6`で次のcommandを使い、stable / experimental schemaを一時directoryに生成した。生成物はversion依存のためrepositoryへ追加していない。

```text
codex app-server generate-json-schema --out <temporary-stable-directory>
codex app-server generate-json-schema --experimental --out <temporary-experimental-directory>
```

| schema | file 数 | 結果 |
| --- | ---: | --- |
| stable | 267 | 生成成功 |
| experimental | 337 | 生成成功 |

## 検証結果

| ID | 状態 | 実際の結果 | 備考 |
| --- | --- | --- | --- |
| CAS-001 | `pass` | `initialize` response を受信し、後続 request を処理できた | wire 上の message に `jsonrpc` field はなかった |
| CAS-002 | `pass` | `model/list` で model と capability field、次 page の cursor を取得できた | catalog 内容は version / account で変動する |
| CAS-003 | `pass` | ephemeral Thread を作成し、Thread ID と `idle` を取得できた | `thread/started` も受信した |
| CAS-004 | `pass` | `turn/start` response で Turn ID と `inProgress` を取得できた | 続けて `thread/status/changed(active)`、`turn/started` を受信した |
| CAS-005 | `pass` | `item/agentMessage/delta` を複数回受信し、連結後の文字列が期待値と一致した | item ID で相関できた |
| CAS-006 | `pass` | assistant の `item/completed`、Thread の `idle`、Turn の `completed` を受信した | 正常完了は `turn/completed` の status で確定する |
| CAS-007 | `pass` | `includeTurns: false` は成功した。ephemeral Thread の `includeTurns: true` は error `-32600` で拒否された | persistent ThreadはCAS-008で別途検証 |
| CAS-008 | `pass` | completed Turnを持つpersistent Threadは、App Server再起動後に`thread/read(includeTurns=true)`で履歴を取得でき、`thread/resume`後に同じThreadで次のTurnを正常完了できた | read / resumeは4回、resume後の継続Turnは1回実施 |
| CAS-009 | `pass` | assistant delta後の`turn/interrupt`は空responseを返し、その後`thread/status/changed(idle)`、`turn/completed(interrupted)`を受信した | 同じprobeを2回実行し同順序。user cancelはterminal eventとの相関後に確定する |
| CAS-010 | `pass` | 不一致`expectedTurnId`とterminal後のsteerは`-32600`で拒否され、一致時は同じTurn IDで受理され、persistent履歴に2件目のuserMessageとして反映された | 同じprobeを2回実行。拒否入力は履歴へ反映されなかった |
| CAS-011 | `not_run` | command / file approval を発生させていない | 専用 workspace が必要 |
| CAS-012 | `not_run` | permission / user input / elicitation を発生させていない | request timeout も確認する |
| CAS-013 | `pass` | assistant delta受信後にstdio App Server processを強制終了すると、別processからの`thread/resume`で同じTurnが`interrupted`として取得できた | 4回実施。Turnの継続と欠落deltaの再配信はなく、履歴にはuserMessageだけが残った |
| CAS-014 | `not_run` | 複数 Thread を並行実行していない | concurrency 方針決定前に必要 |
| CAS-015 | `not_run` | 未知 notification を注入していない | client contract test で扱う |
| CAS-016 | `pass` | completed agentMessageは`commentary` 1件、`final_answer` 1件、`null` 0件で、期待本文は明示的`final_answer`に含まれた | 同じprobeを2回実行。stable schemaは`null`をphase unknownとして引き続き許可する |
| CAS-017 | `blocked` | `codex app-server daemon version`はWindowsでdaemon lifecycle非対応として終了した | 既存daemonのinstall、start、stop、restart、設定変更は行っていない |

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

## daemon client-only再接続のblocked判定

`codex app-server daemon version`は`codex-cli 0.144.6` on Windowsで、daemon lifecycleはUnix platformだけが対応するとして終了した。既存環境を変更せず隔離したdaemonを開始できないため、CAS-017は`blocked`とした。

公式Codex App Server資料では、stdioがdefault transportであり、WebSocketはexperimental / unsupportedである。一方、managed daemonのclient lifecycleは同資料に記載されていない。current CLI helpにはdaemonとcontrol socketへのstdio proxyが存在するが、WindowsではCAS-017を実測できず、WithMateのPersistence WorkerやProvider-neutral control planeも所有しない。よって初期CP3ではCodex daemonへ依存せず、WithMate runtime hostがstdio App Server childを所有する。CLI client-only切断はWithMate local IPC境界で検証し、Provider接続を切断しない。

## 設計への影響

### 確定できた判断

- stdio / JSONL を Codex Adapter の第一 transport として採用できる。
- `codex-cli 0.144.6`でもstable schemaの`turn/steer`、`turn/interrupt`、agentMessage phase契約を確認した。
- Thread ID、Turn ID、item ID を WithMate Session / Run / event と対応付けられる。
- streaming assistant message は delta の順序を保って構築できる。
- `thread/status/changed(idle)` ではなく `turn/completed` の status を Run terminal 判定に使う。
- model catalog は App Server から取得できる。
- Thread mode は ephemeral / persistent を明示的に区別する必要がある。
- completed persistent Turnはprocess再起動後にread / resumeできる。
- stdio App Server processの異常終了時、active Turnは`interrupted`へ収束し、同一Turnの監視再開はできない。
- 切断前に受信した未確定assistant deltaはProvider履歴から復元できない。streaming deltaを永続化しない現行方針では、App Server crash時の未確定draft消失を許容し、復旧時に推測でpartial outputを生成しない。
- interrupt responseはterminal確定ではなく、user cancelと`turn/completed(interrupted)`の相関が必要である。
- steerはactive Turn IDの一致をpreconditionとし、同じTurnのsupplemental user Messageとして履歴へ反映される。拒否と受理不明を後続Runへ転用しない。
- explicit `final_answer`はsuccessful Turnのfinal candidate、`commentary`はassistant detailに分類できる。nullable phaseのfallbackは引き続き必要である。
- 初期CP3はCodex managed daemonを使わず、長寿命WithMate runtime hostがstdio App Server childを所有する。CLI終了はProvider disconnectやRun cancelを意味しない。

### まだ確定できない判断

- approval / elicitationのtimeout、重複回答、切断時の扱い
- 同一App Server process上の複数active Runの許可範囲
- runtime host local IPCのversion negotiation、owner確認、stale endpoint、subscription backpressureの実装契約

## 残リスク

- schemaとruntime contractはCodex CLI versionにより変化しうる。実装時は起動versionとstable schemaに対する契約testをGateにする。
- CAS-010は履歴反映を確認するためpersistent Threadを作る。repository外workspaceの削除後もsyntheticなThreadが設定済みCodex profileへ残る可能性があり、Thread一覧から検知して不要ならarchiveできる。probeは既存Threadを変更せず、Thread IDと本文を証跡へ出力しない。
- CAS-017はWindowsのdaemon lifecycle非対応によりblockedである。採用modelはdaemonを使わず、runtime hostへのclient再接続を後続process testで検証する。
- approval / elicitationは未検証で、CAS-011 / CAS-012を後続`feat/cp03-run-interactions`の実装直前Gateとする。
- `phase=null`はstable schemaでacceptedだが、`codex-cli 0.144.6`の今回promptでは観測していない。fallbackはexecutable mapper contractで固定する必要がある。
- local user configuration による hook / MCP notification も同じ stream に流れるため、Adapter は既知の主要 event だけを前提に停止してはならない。

## 参照

- `docs/investigations/codex-app-server/runtime-contract-probe.mjs`
- `docs/investigations/codex-app-server/recovery-probe.mjs`
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
