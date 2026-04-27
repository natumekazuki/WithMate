# conclusion
- 次スライスは「V2 DB ファイル起動 + session/audit read-path の差替え」に限定する。  
  変更範囲は runtime open-path と既存 IPC 契約を壊さない read API 差し替えまでに抑え、まずは V1→V2 切替の検証可能性を上げる。

# current state
- 確認済み: 起動時 DB ファイルは現状 `withmate.db`（V1）固定、`withmate-v2.db` は未使用。  
- 確認済み: session/audit の read/write チャネルは `WITHMATE_LIST_SESSION_SUMMARIES_CHANNEL`, `WITHMATE_GET_SESSION_CHANNEL`, `WITHMATE_LIST_SESSION_AUDIT_LOGS_CHANNEL` の 3 系に集約される。  
- 確認済み: renderer は session summary と session detail を明確に分離して取得しており、detail を毎回取得している。audit も detail view 時に都度 fetch。  
- 確認済み: `database-schema-v2.ts` は V2 テーブル分割（sessions/messages/artifacts, audit_*_details/operations）を既に定義し、migration write-mode は scripts 側に存在。

# findings
## 1. Recommended next slice boundary (含む/除外)
- 含む
- `src-electron/main.ts`: DB 起動時のパス解決を `APP_DATABASE_V1_FILENAME` 固定から `APP_DATABASE_V2_FILENAME` 優先（必要なら V1 フォールバック）に変更する最小差分を入れる。
- `src-electron/main.ts`: `initializePersistentStores` の呼び出し先が V2 を指す前提になったときの初期化順（`initialize`, `recreate`, WAL, 健康チェック）を壊さないことを確認。
- `src-electron/main-query-service.ts` + `src-electron/main.ts` IPC 呼び出し: session/audit read API の back-end provider を V2 対応実装へ切替し、チャネル名/API 契約は変更しない。
- `src-electron/session-storage.ts`: V2 read map（messages/artifacts 分離）を前提に `Session`/`SessionSummary` を再構成する経路を追加し、既存の `messages_json`/`stream_json` 依存を read-path だけで吸収する。
- `src-electron/audit-log-storage.ts`: V2 の audit detail/operation 分離を read で再構成し、既存 row->object 変換を維持。
- `src-electron/main-query-service.test.ts`, `session-storage.test.ts`, `audit-log-storage.test.ts`: 上記 3 つを V2 read 優先で通すテストを追加。既存 tests は V1 パスを残して互換検証。
- IPC 契約層（`main-ipc-registration.ts`, `preload-api.ts`, `withmate-window-api.ts`）: 仕様変更なしで呼び出し先だけ差し替え（テストでチャネル・シグネチャ維持）。
- 除外
- V2 での新規 write API（新テーブルへの新規 insert/update）ロジックの設計変更。
- migration 実行順序の拡張（再実行や多 DB 共存時の長期運用）全面対応。
- UI 表示ロジック改修（一覧/詳細画面の UX 変更、一覧列追加、audit detail の新規表示）。
- モデルカタログや settings reset 周りの schema 全体見直し。

# 2. Affected files
- `src-electron/main.ts`
- `src-electron/main-query-service.ts`
- `src-electron/main-ipc-registration.ts`
- `src-electron/preload-api.ts`
- `src/withmate-window-api.ts`
- `src/withmate-ipc-channels.ts`
- `src-electron/session-storage.ts`
- `src-electron/audit-log-storage.ts`
- `src/HomeApp.tsx`
- `src/App.tsx`
- テスト:
- `scripts/tests/main-bootstrap-deps.test.ts`
- `scripts/tests/main-ipc-registration.test.ts`
- `scripts/tests/main-query-service.test.ts`
- `scripts/tests/preload-api.test.ts`
- `scripts/tests/session-storage.test.ts`
- `scripts/tests/audit-log-storage.test.ts`
- `scripts/tests/audit-log-service.test.ts`
- `scripts/tests/database-schema-v2.test.ts`
- `scripts/tests/database-v1-to-v2-migration.test.ts`

## 3. Suggested TDD red tests
- `scripts/tests/main-bootstrap-deps.test.ts`
- withmate-v2.db 優先の起動ルート（V2 exists）では V2 経路で初期化を行うこと、V2 なしなら V1 fallback。
- `scripts/tests/main-query-service.test.ts`
- V2 storage が存在する時、`listSessionSummaries`/`getSession`/`listSessionAuditLogs` が V2 由来メソッドを呼ぶこと、V1 fallback の既存呼び出し互換。
- `scripts/tests/session-storage.test.ts`
- V2 構造（`session_messages`, `session_message_artifacts`）から V1 互換 SessionDetail が再構成されること。messages欠損でも summary が健全に取れるケース。
- `scripts/tests/audit-log-storage.test.ts`
- `audit_logs` + `audit_log_details` + `audit_log_operations` の結合で V1 と同等の `AuditLogEntry` が復元されること。
- `scripts/tests/main-ipc-registration.test.ts`
- IPC チャネル名は不変、handler 内で必要時に V2 read provider が利用されることの検知（spy）。
- `scripts/tests/preload-api.test.ts`
- preload invoke 仕様不変（引数・戻り型）を固定し、session/audit の取得経路変更が見えないこと。
- `scripts/tests/audit-log-service.test.ts` + 既存 `database-v1-to-v2-migration.test.ts`
- read migration 後に V2 側 read が期待値と一致する最小レベルの回帰テスト追加。

## 4. Design/doc updates needed before implementation
- docs/design: `withmate-v2` の runtime read-path 戦略（起動時 DB 選択、fallback ルール、データ整合性検証）を明記。
- docs/design: session/audit read model の V1↔V2 マッピング表（列定義・正規化後 API 期待値）を追加。
- `.ai_context` の更新（DI/初期化依存が V1 固定だった場合の修正内容を記述）。
- 実装前に ADR（短）を追加/更新して「read-path 移行のみ先行し write-path は保留」を意思決定として固定。
- migration docs に「write-mode 実装済み、runtime read-path phase 切替」として順序を追記。

## 5. Risks / open questions
- V1 DB しか存在しない初回起動時の fallback 安定性: `withmate-v2.db` がない環境で main-query read が壊れないこと。
- migration 後・migration 未実施環境の混在比率が高い運用で、読み取り側がどの DB を選ぶかの決定基準（タイムスタンプ/flag/存在）を明文化する必要。
- `session-storage.ts` の V2 再構成時に `stream_json` の欠落をどの初期値で扱うか（空配列/undefined）が renderer 仕様と整合するか。
- WAL/再作成処理が V2 ファイルに未接続だとロック回避が再発しうる点は現状挙動の再測定が必要。

# open questions
- V2 DB 選択は「V2 が存在すれば強制採用」か「マイグレーション完了フラグが必要」か。
- migration 完了後に残る `withmate.db` は長期運用で残すか即時破棄対象とするか。
- V1 read compatibility をどのバージョンまで残すか（最初の slice は何リリースまで）。

# question candidates for questions_proposal_path
- V2 起動判定条件: DB ファイル名ベースのみか、schema version テーブル/metadata ガードを追加するか。
- V2 read-path 参照時、session summary と session detail の不一致が発生した場合のフォールバック戦略。
- audit list/detail を V2 へ完全移行した後、旧 `audit_logs` 単体保存形式との同居期間をどこまで許容するか。

# next files or commands
- `Get-Content docs/plans/20260427-identify-data-loading-optimizations/files/r-v2/result.md`
- `Get-Content docs/plans/20260427-identify-data-loading-optimizations/files/r-v2/proposal/summary.md`
