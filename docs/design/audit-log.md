# Audit Log

- 作成日: 2026-03-14
- 対象: Session 実行の監査ログ

## Goal

WithMate 上で行われた session 実行について、後から内容を精査できる監査ログを残す。
少なくとも次を追跡できることを目的にする。

- system prompt
- input prompt
- 実際に provider へ渡した composed prompt
- Codex からの response
- 実行中に発生した操作内容
- failure 時の error

## Decision

- 監査ログは Main Process が記録し、SQLite の独立 table に保存する
- 1 turn を 1 レコードとして保存し、phase を `running / completed / failed` で更新する
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
- `system_prompt_text`
- `input_prompt_text`
- `composed_prompt_text`
- `assistant_text`
- `operations_json`
- `raw_items_json`
- `usage_json`
- `error_message`

`session_id` は `sessions.id` を参照し、session 削除時は `audit_logs` も削除する。
旧 schema の `prompt_text` / `user_message` は互換目的で残ってもよいが、現行 UI と現行 insert は新列を正本にする。

## Logging Flow

### running

- `runSessionTurn()` 開始直後に作成する
- prompt composer の結果を
  - `system_prompt_text`
  - `input_prompt_text`
  - `composed_prompt_text`
  に分けて保存する
- まだ実行結果が無いため、response / operations / usage は空でよい

### completed

- Codex SDK の turn 完了後に同じレコードを更新する
- `assistant_text`
- `operations_json`
- `raw_items_json`
- `usage_json`
を保存する
- `runStreamed()` で表示した step のうち、確定した `turn.items` から再構築できる内容だけを残す

### failed

- provider 実行が error で終わった場合に同じレコードを更新する
- `error_message` を必須で保存する
- response / operations / usage は空でもよい

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

`raw_items_json` は Codex SDK の `turn.items` をそのまま JSON で残す。
`assistant_text` は Session UI と同じ表示基準で、複数の `agent_message` を arrival 順に空行区切りで連結した結果を保存する。
個々の `agent_message` の粒度確認が必要な場合は `operations_json` または `raw_items_json` を使う。

## UI

Session Window の header から `Audit Log` overlay を開く。

overlay では 1 entry ごとに次を表示する。

- phase
- timestamp
- provider / model / reasoning / approval
- system prompt
- input prompt
- composed prompt
- response
- operations
- usage
- error
- raw items

長文になりやすい `system prompt` `input prompt` `composed prompt` `response` `operations` `usage` `error` `raw items` は、entry card 内でカテゴリ単位の折りたたみ表示にする。
初期状態では `input prompt` だけを開き、他は閉じた状態から必要な箇所だけ個別に開いて読む。

`composed prompt` は text payload だけを表す。画像添付がある場合でも、画像本体はここには含まれない。

## Non Goals

- Session 一覧上での監査ログ常設表示
- 監査ログの全文検索
- 監査ログ export
- live step の逐次永続化

## Related Documents

- `docs/design/provider-adapter.md`
- `docs/design/electron-session-store.md`
- `docs/design/desktop-ui.md`
- `docs/design/session-persistence.md`
- `docs/manual-test-checklist.md`
