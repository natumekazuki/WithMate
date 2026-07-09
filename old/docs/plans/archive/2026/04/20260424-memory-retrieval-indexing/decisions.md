# Decisions

- 2026-04-24: repo plan として管理する。理由は新規 plan ファイル追加、retrieval ロジック変更、design doc 更新を含むため。
- 2026-04-24: 永続 schema は変更せず、retrieval 呼び出し内の runtime index に限定する。
- 2026-04-24: 公開 API は同期の `retrieveProjectMemoryEntries` / `retrieveCharacterMemoryEntries` のまま維持する。
