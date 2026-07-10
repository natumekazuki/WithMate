# Codex App Server Capability Matrix

- 調査日: 2026-07-10
- 対象 version: `codex-cli 0.144.1`
- 関連設計: `docs/design/provider-integration.md`
- 状態: 初期調査済み

## 目的

Codex App Server が WithMate の Provider Adapter に必要な操作と event を提供できるか整理し、設計で採用できる範囲と追加検証が必要な範囲を分ける。

本書は特定 version の調査結果である。正式な実装では起動時に CLI version と capability を記録し、生成 schema と runtime 契約 test で互換性を確認する。

## 判定区分

| 区分 | 意味 |
| --- | --- |
| 実測済み | ローカル環境で request / notification を確認した |
| 仕様・schema 確認 | 公式仕様と生成 schema で確認したが runtime 未検証 |
| Experimental | `--experimental` を付けた schema にのみ存在するか、公式に experimental とされる |
| 対象外 | 初期 WithMate Provider Adapter では利用しない |

## Transport と初期化

| 能力 | App Server contract | 判定 | WithMate での扱い |
| --- | --- | --- | --- |
| process 起動 | `codex app-server` | 実測済み | WithMate が子 process として起動・監視する |
| transport | stdio 上の 1 行 1 JSON message | 実測済み | stdout を protocol 専用、stderr を診断用として扱う |
| 初期化 | `initialize` request、`initialized` notification | 実測済み | 接続確立前の必須 handshake とする |
| protocol envelope | JSON-RPC 2.0 に近い形式。ただし wire 上で `jsonrpc` field を省略 | 実測済み | 汎用 JSON-RPC library を使う場合は省略形式への対応を確認する |
| WebSocket transport | experimental / unsupported | Experimental | 初期実装では採用しない |

## 会話と実行

| WithMate の要求 | App Server contract | 判定 | 設計判断 |
| --- | --- | --- | --- |
| 新規外部会話 | `thread/start` | 実測済み | WithMate Session の Codex binding に Thread ID を保持する |
| 外部会話の再開 | `thread/resume` | 仕様・schema 確認 | process 再起動を含む runtime 検証が必要 |
| 外部会話の取得 | `thread/read` | 実測済み | provider 状態の照合に使えるが、共通履歴の正本にはしない |
| 外部会話の一覧 | `thread/list` | 仕様・schema 確認 | recovery / diagnostics 候補。通常の Session 一覧は WithMate DB を使う |
| 1 回の実行開始 | `turn/start` | 実測済み | WithMate Run と Turn ID を対応付ける |
| 実行中の追加指示 | `turn/steer` | 仕様・schema 確認 | `expectedTurnId` による active Turn の一致確認が必須 |
| 実行中断 | `turn/interrupt` | 仕様・schema 確認 | terminal status `interrupted` と WithMate の user cancel を対応付ける runtime 検証が必要 |
| assistant streaming | `item/agentMessage/delta` | 実測済み | item ID と順序を保って Message draft へ投影する |
| item lifecycle | `item/started`、`item/completed` | 実測済み | message / command / file change などの進行を Run event として記録する |
| Turn lifecycle | `turn/started`、`turn/completed` | 実測済み | Run の開始・terminal 判定に使う |
| Thread live state | `thread/status/changed` | 実測済み | `active` / `idle` は Provider の観測値として保持し、WithMate Run phase / activity の正本にはしない |

## 状態

生成 schema で確認した Turn status は次の 4 つ。

| Codex Turn status | WithMate Run phase の初期対応 |
| --- | --- |
| `inProgress` | `active`。通知内容と pending interaction から activity を投影する |
| `completed` | `completed` |
| `failed` | `failed` |
| `interrupted` | user による interrupt の完了を確認できた場合は `canceled`、原因不明の切断時は `interrupted` |

Thread status は少なくとも `active`、`idle`、`systemError` を持つ。Thread status と Turn status は別物として保持し、`idle` だけで Run の正常完了を確定しない。

## Approval と追加入力

| 能力 | Server request | 判定 | 設計判断 |
| --- | --- | --- | --- |
| command 実行承認 | `item/commandExecution/requestApproval` | 仕様・schema 確認 | Run activity を `waiting_approval` へ投影する |
| file 変更承認 | `item/fileChange/requestApproval` | 仕様・schema 確認 | Run activity を `waiting_approval` へ投影する |
| permission 承認 | `item/permissions/requestApproval` | 仕様・schema 確認 | command / file 承認と payload を混同しない |
| user input | `item/tool/requestUserInput` | 仕様・schema 確認 | Run activity を `waiting_input` へ投影する |
| MCP elicitation | `mcpServer/elicitation/request` | 仕様・schema 確認 | Provider 固有 payload を保持しつつ共通入力要求へ投影する |
| request 解決通知 | `serverRequest/resolved` | 仕様・schema 確認 | 二重回答防止と pending state 解消に使う |

App Server から WithMate への server request は通常の notification と異なり、WithMate が同じ request ID へ response を返す必要がある。process 切断、timeout、重複回答時の挙動は追加検証する。

## Model と capability

| 能力 | App Server contract | 判定 | 設計判断 |
| --- | --- | --- | --- |
| model 一覧 | `model/list` | 実測済み | model ID、表示名、reasoning effort、入力 modality などを取得できる |
| Provider capability | `modelProvider/capabilities/read` | 仕様・schema 確認 | model 選択 UI / CLI の feature gate 候補 |
| pagination | `cursor`、`limit` | 実測済み | catalog refresh は全 page を取得する |
| hidden model | `includeHidden` | 仕様・schema 確認 | 通常表示では含めず、diagnostics でのみ選択可能にするか別途判断する |

## Provider 履歴を正本にしない理由

生成 schema では、Thread の `turns` は `thread/read(includeTurns=true)` など一部操作でのみ読み込まれる。また、永続化された Thread item は lossless な event ledger ではなく、command execution など一部 interaction が保持されない場合がある。

このため次を設計上の前提とする。

- WithMate の Session / Message / Run event を表示・監査用履歴の正本にする。
- Codex Thread は Codex 側で会話を継続するための外部状態として扱う。
- reconnect 時の `thread/read` は照合・復旧補助に使い、WithMate 履歴を全面的に再構築する用途には使わない。
- 未知 event を破棄せず、sanitize した診断情報を残す。

## Experimental schema の扱い

`--experimental` 付き schema では process 制御、Thread item / Turn 一覧、remote control、一部 realtime request などの追加 API が生成される。初期 Provider Adapter は stable schema に含まれる操作だけを基準とし、experimental API を必須機能にしない。

## 追加検証が必要な項目

- 永続 Thread の `thread/resume` と `thread/read(includeTurns=true)`
- `turn/interrupt` の request、notification、terminal status の順序
- `turn/steer` の受理条件、拒否条件、message history への反映
- command / file / permission approval の allow、deny、timeout、重複回答
- `item/tool/requestUserInput` と MCP elicitation の回答形式
- App Server crash、stdin close、client crash 後の Thread / Turn の扱い
- 同一 process 上の複数 Thread / Turn の event 相関と並行性
- `modelProvider/capabilities/read` の version 差分

## 参照

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- `docs/investigations/codex-app-server/validation-plan.md`
- `docs/investigations/codex-app-server/validation-results.md`
