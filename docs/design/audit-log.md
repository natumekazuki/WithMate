# Audit Log

- 作成日: 2026-03-14
- 更新日: 2026-04-27
- 対象: Session 実行の監査ログ

## Goal

WithMate 上で行われた session 実行について、後から内容を精査できる監査ログを残す。
少なくとも次を追跡できることを目的にする。

- 論理的な prompt 構成
- 実際に provider へ渡した transport payload
- Codex からの response
- 実行中に発生した操作内容
- failure 時の error

## Decision

- 監査ログは Main Process が記録し、SQLite の独立 table に保存する
- 1 turn を 1 レコードとして保存し、phase を `running / completed / canceled / failed` で更新する
- background task は通常 turn と混ぜず、専用 phase と transport payload で区別する
- current runtime では MemoryGeneration / Character Reflection / Monologue の background task は新規作成しない
- Session Window から overlay で閲覧できるようにする
- session payload とは分離し、監査用途の履歴として扱う
- stream 中の一時表示は監査ログの正本にしない

## Storage

SQLite の `audit_logs` table を使う。

- `id`
- `session_id`
- `created_at`
- `phase`
- `provider`
- `model`
- `reasoning_effort`
- `approval_mode`
- `thread_id`
- `logical_prompt_json`
- `transport_payload_json`
- `assistant_text`
- `operations_json`
- `raw_items_json`
- `usage_json`
- `error_message`

`session_id` は `sessions.id` を参照し、session 削除時は `audit_logs` も削除する。
`logical_prompt_json` は次の形を基本にする。

```json
{
  "systemText": "...",
  "inputText": "...",
  "composedText": "..."
}
```

`transport_payload_json` は次の形を基本にする。
- Copilot では premium request quota の current snapshot を補助 field として付与してよい
- 実行時間や retrieval 件数のような補助 metadata も `fields` に付与してよい

```json
{
  "summary": "Copilot session.send payload",
  "fields": [
    { "label": "session.send.prompt", "value": "..." }
  ]
}
```

旧 schema の `prompt_text` / `user_message` / `system_prompt_text` / `input_prompt_text` / `composed_prompt_text` は write-path の正本にしない。
`approval_mode` は新規保存時は provider-neutral canonical value `allow-all / safety / provider-controlled` を正本にする。
既存 row に残る `never / untrusted / on-request / on-failure` は read-path normalize で吸収し、one-shot migration は前提にしない。

## Background Memory Extraction

`Session Memory` の裏実行は current runtime では行わない。  
この section は、過去バージョンで保存された background memory extraction / character reflection log を読むための互換仕様として残す。

### Phase

legacy background task には次の phase が残る場合がある。

- `background-running`
- `background-completed`
- `background-failed`
- `background-canceled`

通常 turn の `running / completed / canceled / failed` と名前を分けることで、overlay や集計時に区別しやすくする。

### Stored Shape

legacy background memory extraction でも `audit_logs` table 自体は共用していた。  
既存 row は次のような形で残る場合がある。

- `logical_prompt_json`
  - extraction prompt の論理構成
  - 既存 Session Memory と recent messages を含む
- `transport_payload_json`
  - extraction model / reasoning depth / timeout / trigger reason
  - Copilot の場合は取得できた premium request quota も付与する
  - 実行時間や memory 件数も補助 field として付与してよい
  - 例:
    - `trigger: outputTokensThreshold`
    - `trigger: manual`
    - `timeoutSeconds: 180`
    - `remainingPercentage: 76%`
    - `remainingRequests: 380 / 500`
    - `durationMs: 1840`
    - `projectMemoryPromotions: 2`
    - `characterMemorySaved: 1`
- `assistant_text`
  - provider が返した raw JSON text
- `operations_json`
  - 基本は空でよい
- `raw_items_json`
  - provider ごとの stable trace を必要最小限で残す
  - background task でも `[]` 固定にせず、provider response と補助 metadata を compact trace として残す
- `usage_json`
  - extraction run 自体の usage
- `error_message`
  - parse failure や provider failure を残す

### Visibility Policy

Session Window の Audit Log overlay では、既存 background task を通常 turn と同じ一覧に混在表示しない。  
UI では `Main` と `Background` を切り替えて見られるようにし、通常 turn と legacy background task の確認面を分ける。

### Why Not Separate Table

legacy design では memory extraction も「実際に provider へ投げた background task」であり、監査粒度は通常 turn と近かった。  
そのため table を増やさず、`phase` と payload の区別で扱っていた。

将来、background task が増えすぎて UI / query が煩雑になった場合だけ、専用 table への分離を follow-up で検討する。

## Logging Flow

### running

- `runSessionTurn()` 開始直後に作成する
- prompt composer の結果を `logical_prompt_json` に保存する
- まだ実行結果が無いため、response / operations / usage は空でよい
- `transport_payload_json` は provider 実行後に確定するまでは空でもよい
- current 実装では同じ `running` record を live progress に合わせて段階更新してよい
  - `assistant_text`
  - `operations_json`
  - `usage_json`
  - `error_message`
  - `thread_id`
- renderer は `session.runState === running` の間だけ persisted の `running` row に live state を merge して表示し、terminal 化済み record を stale な live state で上書きしない

### completed

- Codex SDK の turn 完了後に同じレコードを更新する
- `assistant_text`
- `operations_json`
- `raw_items_json`
- `usage_json`
を保存する
- Copilot の場合は `transport payload` に premium request quota の snapshot を補助 field として付与してよい
  - `remainingPercentage`
  - `remainingRequests`
  - `resetDate`
- current 実装では次の補助 metadata も付与する
  - `durationMs`
  - `projectMemoryHits`
  - `attachmentCount`
- `runStreamed()` で表示した step のうち、確定した `turn.items` から再構築できる内容だけを残す

### canceled

- ユーザーが `Cancel` を押した場合に同じレコードを更新する
- `error_message` にユーザーキャンセルを残す
- 途中まで取得できた `assistant_text` / `operations_json` / `raw_items_json` / `usage_json` があれば残す

### failed

- provider 実行が error で終わった場合に同じレコードを更新する
- `error_message` を必須で保存する
- 途中まで取得できた `assistant_text` / `operations_json` / `raw_items_json` / `usage_json` があれば残す

## Operation Summary

`operations_json` は監査で読みやすい要約レイヤとして扱う。

- `command_execution`
- `file_change`
- `mcp_tool_call`
- `web_search`
- `todo_list`
- `reasoning`
- `error`
- `agent_message`
- `approval_request`
- `elicitation_request`
- `background-*`

`raw_items_json` は provider ごとの raw trace をそのまま抱え込むための列ではなく、監査で読む stable event trace を JSON で残す。
- Codex は `turn.items` ベースの raw item を残す
- Copilot は `assistant.message_delta` や `assistant.reasoning_delta` のような stream packet は落とし、`tool.execution_*`、`assistant.message`、`assistant.usage` などの stable event だけを残す
- background task は stable event stream を持たない provider もあるため、current 実装では `background-response` 相当の compact trace を残す
`assistant_text` は Session UI と同じ表示基準で、複数の `agent_message` を arrival 順に空行区切りで連結した結果を保存する。
個々の `agent_message` の粒度確認が必要な場合は `operations_json` または `raw_items_json` を使う。

## UI

Session Window の header から `Audit Log` overlay を開く。

overlay では 1 entry ごとに次を表示する。

- phase
- timestamp
- provider / model / reasoning / approval
- logical prompt
- transport payload
- response
- operations
- usage
- error
- raw items

長文になりやすい `logical prompt` `transport payload` `response` `operations` `usage` `error` `raw items` は、entry card 内でカテゴリ単位の折りたたみ表示にする。
初期状態はすべて閉じた状態から必要な箇所だけ個別に開いて読む。

`logical prompt` は人間が読むための論理構成であり、provider 実 transport と完全一致する必要はない。
実 transport は `transport payload` 側を正本として扱う。
approval は UI 上では `自動実行 / 安全寄り / プロバイダー判断` の provider-neutral wording で表示する。
そのため、保存値が legacy/native でも overlay 表示時には canonical mode へ normalize したうえで同じ wording に揃える。
background task の completed / failed / canceled 更新で `updatedAt` または status が変わった場合、renderer は Audit Log 一覧を再取得して response / error / raw items の確定値を stale にしない。

## Non Goals

- Session 一覧上での監査ログ常設表示
- 監査ログの全文検索
- 監査ログ export
- provider stream packet の逐次全量永続化
- memory extraction の結果だけを別 UI で編集すること

## Related Documents

- `docs/design/provider-adapter.md`
- `docs/design/electron-session-store.md`
- `docs/design/desktop-ui.md`
- `docs/design/electron-session-store.md`
- `docs/design/database-schema.md`
- `docs/manual-test-checklist.md`
