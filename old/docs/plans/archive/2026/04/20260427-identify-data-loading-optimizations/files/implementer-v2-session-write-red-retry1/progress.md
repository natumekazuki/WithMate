# Progress

- ステータス: red 提案作成完了
- slice id: `implementer-v2-session-write-red-retry1`
- phase: `V2 write path / session`
- tdd mode: `red`
- 変更先: `scripts/tests/session-storage-v2-read.test.ts`
- 追加内容:
  - `upsertSession` の復元テスト
  - `replaceSessions` の置換テスト
  - `deleteSession` の child rows 破棄テスト
  - `clearSessions` の child rows 破棄テスト
- 実装ファイル: なし（提案の red テストのみ）
