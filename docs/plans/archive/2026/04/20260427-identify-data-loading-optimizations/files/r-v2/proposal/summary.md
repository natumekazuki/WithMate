# conclusion
- 次スライスは「V2 DB 起動 + session/audit 読み取り経路の差し替え」に限定。  
- 目的は `withmate-v2.db` への移行を runtime で実現し、API 契約は維持したまま読み取りの互換壊れを避けること。

# current state
- 起動時 DB は現在 `withmate.db` 固定で、V2 ファイルは起動ロジック未使用。
- session/audit の IPC 経路は既存チャネル 3 つが中心（summary/list/detail）で renderer 側 expectation もこの3 APIを前提。
- session/audit ストレージの現行実装は V1 形式（session/messages/artifacts 分離なし、audit_details/opérations 未分割）。
- V2 schema と V1→V2 migration write-mode は既に存在。

# findings
- 主要差分は「DB ファイル選択」と「リポジトリ層 read 実装」のみで始められる。
- renderer の session summary / detail 分離フローと cache invalidation は read-path 切替に相性が良く、最初の slice として小さめに収まりやすい。
- IPC チャネルや API 契約は変更せず、service/provisioning 層で V2 read を参照に変えるのが安全。
- テスト観点は既存 main-query/session/audit/storage に集中すれば slice 境界を保てる。

# next files or commands
- `src-electron/main.ts`
- `src-electron/main-query-service.ts`
- `src-electron/session-storage.ts`
- `src-electron/audit-log-storage.ts`
- `src-electron/main-ipc-registration.ts`
- `src-electron/preload-api.ts`
- `src/withmate-window-api.ts`
- `src/withmate-ipc-channels.ts`
- `scripts/tests/main-bootstrap-deps.test.ts`
- `scripts/tests/main-query-service.test.ts`
- `scripts/tests/session-storage.test.ts`
- `scripts/tests/audit-log-storage.test.ts`

# open questions
- V2 起動時は「存在判定」だけでよいか、schema/flag チェックを追加するか。
- V1 fallback 方針（起動・再生成・リセット）をどの段階まで同居させるか。
- `stream_json` を V2 でどう補完・欠損許容するか。
