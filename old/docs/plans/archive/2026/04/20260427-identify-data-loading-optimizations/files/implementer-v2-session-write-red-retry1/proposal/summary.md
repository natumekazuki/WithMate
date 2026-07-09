# 進行提案 (implementer-v2-session-write-red-retry1)

- slice id: `implementer-v2-session-write-red-retry1`
- phase: `V2 write path / session`
- tdd mode: `red`
- 目的: `SessionStorageV2Read` の write API を未実装前提にした red テストを追加し、V2 session write の仕様を先に固定する。
- 対象ファイル: `scripts/tests/session-storage-v2-read.test.ts`

## 追加 Red テスト

- `upsertSession`
  - メソッド呼び出しで `sessions`, `session_messages`, `session_message_artifacts` を扱える期待を置き、
    `getSession` で `messages`・`artifact`・`stream: []` の復元を検証する。
- `replaceSessions`
  - 置換対象 session の新規データ復元と、置換されない child rows の不在を検証する。
- `deleteSession`
  - 削除 session の `sessions` + `session_messages` + `session_message_artifacts` が残らないことを検証する。
- `clearSessions`
  - 全件削除後に session 系テーブルが空になることを検証する。

## 実装方針

- 実装コードは変更しない。
- テスト追加のみで、期待される失敗状態を明示する。
