# 進行提案 (implementer-v2-session-write-green)

- slice id: `implementer-v2-session-write-green`
- phase: `V2 write path / session`
- tdd mode: `green`
- 目的: `SessionStorageV2Read` に V2 write API を実装し、既存 read 挙動を維持しつつ `upsertSession` / `replaceSessions` / `deleteSession` / `clearSessions` を有効化する。
- 対象ファイル: `src-electron/session-storage-v2-read.ts`

## 追加する実装要件

- `upsertSession`: V2 schema (`sessions`, `session_messages`, `session_message_artifacts`) へ transaction 内で保存。
- `replaceSessions`: transaction 内で session 系 table 全置換。
- `deleteSession` / `clearSessions`: `sessions` 削除時の cascade 前提で、子テーブル破棄を担保。
- `stream` は V2 保存しない（`getSession` の復元は `stream: []` のまま）。
- `message_count` は `messages.length`、`last_active_at` は upsert/replace 指定の値を採用。
- `audit_log_count` は既存 header があれば維持、未取得時は `0`。
- `allowed_additional_directories_json` は `JSON.stringify(session.allowedAdditionalDirectories ?? [])`。
- `artifact` がある message のみ `session_message_artifacts` に insert（`created_at` は空文字）。
- `main.ts` の writable guard は、今回のクラス追加実装のみで通る前提。

## 進行上の方針

- 実装コード本体は `changes.patch` のみで提案。
- 必要なら最小修正は `main.ts` は現在不要とする。
