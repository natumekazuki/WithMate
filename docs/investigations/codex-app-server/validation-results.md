# Codex App Server Validation Results

- 実施日: 2026-07-10、2026-07-12
- 状態: 基本通信、persistent Thread再開、App Server異常終了後の復旧判定を実施済み
- 検証計画: `docs/investigations/codex-app-server/validation-plan.md`
- 関連設計: `docs/design/provider-integration.md`, `docs/design/codex-app-server-adapter-contract.md`

## 実行環境

| 項目 | 値 |
| --- | --- |
| OS | Windows 10.0.26200, x86_64 |
| Codex CLI version | `0.144.1` |
| Transport | stdio / newline-delimited JSON |
| Workspace | repository 外の一時 directory |
| Thread mode | ephemeral / persistent |
| Sandbox | read-only |
| Approval policy | never |

## schema 調査

次の command で stable / experimental schema を一時 directory に生成した。生成物は version 依存のため repository へ追加していない。

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
| CAS-009 | `not_run` | 長時間 Turn と interrupt を実行していない | cancel phase mapping 確定前に必要 |
| CAS-010 | `not_run` | active Turn への steer を実行していない | `expectedTurnId` の競合も確認する |
| CAS-011 | `not_run` | command / file approval を発生させていない | 専用 workspace が必要 |
| CAS-012 | `not_run` | permission / user input / elicitation を発生させていない | request timeout も確認する |
| CAS-013 | `pass` | assistant delta受信後にstdio App Server processを強制終了すると、別processからの`thread/resume`で同じTurnが`interrupted`として取得できた | 4回実施。Turnの継続と欠落deltaの再配信はなく、履歴にはuserMessageだけが残った |
| CAS-014 | `not_run` | 複数 Thread を並行実行していない | concurrency 方針決定前に必要 |
| CAS-015 | `not_run` | 未知 notification を注入していない | client contract test で扱う |
| CAS-016 | `not_run` | agentMessage `phase` の `commentary` / `final_answer` / `null` パターンを実行していない | final Message mapper の契約確定に必要 |
| CAS-017 | `not_run` | App Server daemonを残したclient-only切断を実行していない | 常駐process modelを採用する場合に検証 |

## 観測した通信順序

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

## 設計への影響

### 確定できた判断

- stdio / JSONL を Codex Adapter の第一 transport として採用できる。
- Thread ID、Turn ID、item ID を WithMate Session / Run / event と対応付けられる。
- streaming assistant message は delta の順序を保って構築できる。
- `thread/status/changed(idle)` ではなく `turn/completed` の status を Run terminal 判定に使う。
- model catalog は App Server から取得できる。
- Thread mode は ephemeral / persistent を明示的に区別する必要がある。
- completed persistent Turnはprocess再起動後にread / resumeできる。
- stdio App Server processの異常終了時、active Turnは`interrupted`へ収束し、同一Turnの監視再開はできない。
- 切断前に受信した未確定assistant deltaはProvider履歴から復元できない。streaming deltaを永続化しない現行方針では、App Server crash時の未確定draft消失を許容し、復旧時に推測でpartial outputを生成しない。

### まだ確定できない判断

- user cancel を `canceled` と判定できる exact event sequence
- daemonを残したclient-only切断時にactive Turnへ再接続できるか
- approval / elicitation の timeout、重複回答、切断時の扱い
- 複数 active Run の許可範囲

## 残リスク

- schema と runtime contract は Codex CLI version により変化しうる。
- completed persistent Threadの履歴読取とresumeは検証済みだが、常駐daemonへのclient再接続は未検証。
- 承認、追加入力、interrupt、steerはschema確認のみである。
- agentMessage `phase` は schema で確認したが、実際の model / execution ごとの付与と `null` fallback は未検証である。
- local user configuration による hook / MCP notification も同じ stream に流れるため、Adapter は既知の主要 event だけを前提に停止してはならない。
