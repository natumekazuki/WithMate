# Codex App Server Validation Results

- 実施日: 2026-07-10
- 状態: 基本通信を実施済み / lifecycle 詳細は未実施
- 検証計画: `docs/investigations/codex-app-server/validation-plan.md`
- 関連設計: `docs/design/provider-integration.md`

## 実行環境

| 項目 | 値 |
| --- | --- |
| OS | Windows 10.0.26200, x86_64 |
| Codex CLI version | `0.144.1` |
| Transport | stdio / newline-delimited JSON |
| Workspace | repository 外の一時 directory |
| Thread mode | ephemeral |
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
| CAS-007 | `pass` | `includeTurns: false` は成功した。ephemeral Thread の `includeTurns: true` は error `-32600` で拒否された | persistent Thread は未検証 |
| CAS-008 | `not_run` | 永続 Thread を作成していない | provider state を残すため別検証に分離 |
| CAS-009 | `not_run` | 長時間 Turn と interrupt を実行していない | cancel phase mapping 確定前に必要 |
| CAS-010 | `not_run` | active Turn への steer を実行していない | `expectedTurnId` の競合も確認する |
| CAS-011 | `not_run` | command / file approval を発生させていない | 専用 workspace が必要 |
| CAS-012 | `not_run` | permission / user input / elicitation を発生させていない | request timeout も確認する |
| CAS-013 | `not_run` | 実行中の切断・異常終了を行っていない | recovery 設計前に必要 |
| CAS-014 | `not_run` | 複数 Thread を並行実行していない | concurrency 方針決定前に必要 |
| CAS-015 | `not_run` | 未知 notification を注入していない | client contract test で扱う |

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

## 設計への影響

### 確定できた判断

- stdio / JSONL を Codex Adapter の第一 transport として採用できる。
- Thread ID、Turn ID、item ID を WithMate Session / Run / event と対応付けられる。
- streaming assistant message は delta の順序を保って構築できる。
- `thread/status/changed(idle)` ではなく `turn/completed` の status を Run terminal 判定に使う。
- model catalog は App Server から取得できる。
- Thread mode は ephemeral / persistent を明示的に区別する必要がある。

### まだ確定できない判断

- user cancel を `canceled` と判定できる exact event sequence
- process 再起動後の resume と欠落 event の復旧方法
- approval / elicitation の timeout、重複回答、切断時の扱い
- 複数 active Run の許可範囲

## 残リスク

- schema と runtime contract は Codex CLI version により変化しうる。
- 今回は ephemeral Thread のため、永続履歴と resume は未検証。
- 承認、追加入力、interrupt、steer、異常終了は schema 確認のみである。
- local user configuration による hook / MCP notification も同じ stream に流れるため、Adapter は既知の主要 event だけを前提に停止してはならない。
