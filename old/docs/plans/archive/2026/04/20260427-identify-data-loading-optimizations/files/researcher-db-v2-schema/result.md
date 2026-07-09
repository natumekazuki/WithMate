# 結論
- V1 は `sessions.messages_json` / `sessions.stream_json` / `audit_logs` の JSON 集約構造と、`listSessions()` / `getSnapshot()` / `listSessionAuditLogs()` のフルスキャン読み込みが、起動時〜選択時の主要な読み込みボトルネックとして確認できた。
- V2 では `sessions` をヘッダ主導に分離し、メッセージと監査詳細を子テーブルへ正規化、`listSessions` は要約列のみを返す形へ変更するのが、調査対象の回収ポイント改善に最も整合的。
- `database-schema-v2.ts` は現在ドラフト記述のため、V2 スキーマ実体は未実装の状態である。

# 現状
- 実行経路: `Home`/`App` から `preload-api` 経由で `main-query-service`/`main-ipc-registration`/`main-ipc-deps` に到達し、最終的に `SessionStorage` / `AuditLogStorage` / `MemoryManagementService` で実データ取得。
- `SessionStorage` では `listSessions()` が `sessions.messages_json` / `sessions.stream_json` を含めて全行を `JSON.parse` し、`listSessionSummaries()` は既に軽量列で取得。
- `MemoryManagementService.getSnapshot()` は `listSessions()` を必須呼び出しとしており、セッション本文を含めた状態で毎回取得。
- `AuditLogStorage.listSessionAuditLogs()` は全JSON列を含む全件を並べ替えのみして返却。
- `SessionMessageColumn`・`SessionAuditLogModal` は renderer 側で受け取った全件を即時レンダリングするため、重いデータを受け取ると UI 側負荷が増大。

# 所見
## 1. V2 Schema の候補（table / columns / indexes）
- `sessions`（V1 header寄り）
  - columns: `id`（PK）, `created_at`, `updated_at`, `last_active_at`, `task_title`, `project_name`, `session_status`, `status`, `model_name`, `temperature`, `max_tokens` など既存 V1 ヘッダ系を保持。
  - indexes: `sessions(last_active_at DESC)`, `sessions(created_at DESC)`, `sessions(task_title)`。
- `session_messages`
  - columns: `id`（PK）, `session_id`（FK）, `sequence`（整列順）, `message_type`, `role`, `content`, `created_at`, `metadata_json`（最小限）, `tool_call_json`。
  - indexes: `session_messages(session_id, sequence)`, `session_messages(session_id, created_at DESC)`, `session_messages(session_id, message_type)`。
- `session_stream_entries`（stream JSON 分離）
  - columns: `id`（PK）, `session_id`（FK）, `sequence`, `chunk`, `created_at`。
  - indexes: `session_stream_entries(session_id, sequence)`。
- `audit_logs`
  - columns: `id`（PK）, `session_id`（FK）, `timestamp`, `level`, `event_type`, `event_category`, `summary`, `message`, `metadata_json`（必要最小）。
  - indexes: `audit_logs(session_id, timestamp DESC)`, `audit_logs(session_id, event_type)`, `audit_logs(timestamp DESC)`。
- `audit_log_details`（V1 の重い JSON 分離先）
  - columns: `id`（PK）, `audit_log_id`（FK）, `logical_prompt_json`, `transport_payload_json`, `operations_json`, `raw_items_json`, `usage_json`, `error_json`, `extras_json`。
  - indexes: `audit_log_details(audit_log_id)`。
- `memory` 系（短期は移行対象外）
  - `project_memory_entries`, `character_memory_entries` は V2 主 schema から除外前提。必要なら互換用に読み出し専用 view または別DBアーカイブに分離。

## 2. V1 → V2 migration 対応表（copy / transform / skip）
- copy
  - `sessions` のヘッダ系列: `id` を中心に V2 `sessions` へそのままコピー。
  - `audit_logs` メタ列: セッション/イベント識別、時間、レベル、要約系を `audit_logs` へコピー。
- transform
  - `sessions.messages_json` → `session_messages`: 1件のセッションJSON配列を展開し、`sequence` を付与して逐次INSERT。
  - `sessions.stream_json` → `session_stream_entries`: ストリームイベントを時系列/順序順に再構築してINSERT（保持ポリシー未確定）。
  - `audit_logs` の各重い JSON を `audit_log_details` に分離: `logical_prompt_json`,`transport_payload_json`,`operations_json`,`raw_items_json`,`usage_json` を構造を崩さず保存。
  - V1 破損JSONは `JSON.parse` 失敗時に `details_raw_text` 退避または skip しつつエラー表に残す（実装方針要決定）。
- skip
  - `session_memories` / `project_scopes` / `project_memory_entries` / `character_scopes` / `character_memory_entries` は V2 主要スキーマ外。
  - 参照要件が残る場合は移行前にアーカイブ（別ファイルまたは別DB）として保持。
  - 既知の未使用列/履歴列は V2 で非推奨化。

## 3. data-loading-performance-audit への効き方
- `listSessions()` が全件の `messages_json`/`stream_json` を読み込む
  - V2: `listSessionSummaries` を標準化し、UI初期化時は要約列のみ取得。
  - message 本文が必要な画面遷移時のみ `session_messages` を読み込む。
- `getSnapshot()` が全 session + 全 memory をまとめて読む
  - V2: snapshot API は sessions summary / メモリ件数集約に限定、message本文なしに変更。
  - 既存 `buildFilteredMemoryManagementSnapshot` への入力を縮退。
- `listSessionAuditLogs()` が重いJSONを全件パース
  - V2: 一覧は軽量監査メタ（5〜10列）に絞り、詳細は `listSessionAuditLogDetails(id)` で遅延取得。
  - 併せて `limit/offset` を導入。
- renderer の `messages.map` 全件レンダリング
  - V2: 表示用にページング/ウィンドウ取得、折返し時は差分読み込みに変更。
  - `SessionAuditLogModal` は初期表示をサマリのみ表示し展開時に detail を取得。
- search precompute の全データ依存
  - V2: summary レベルでの検索対象キーのみを生成し、message本体を含む全探索を回避。

## 4. 実装上の影響ファイルと順序
- 変更順（推奨）
  1. `src-electron/database-schema-v2.ts` に DDL を確定（`sessions`,`session_messages`,`session_stream_entries`,`audit_logs`,`audit_log_details`）。
  2. migration スクリプト追加（V1 スキーマ検証→dry-run→変換→V2投入→整合検査）。
  3. `src-electron/session-storage.ts`：`listSessionSummaries()` と `getSessionMessages/getSession` の分離。
  4. `src-electron/audit-log-storage.ts`：一覧/詳細の分割API (`listSessionAuditLogs` と `getAuditLogDetail` 等)。
  5. `src-electron/memory-management-service.ts`：snapshot 軽量化（session message 参照削減）。
  6. `src-electron/main-query-service.ts`, `main-ipc-deps.ts`, `main-ipc-registration.ts`：新しい query ハンドルを注入。
  7. `src-electron/preload-api.ts` と `src/withmate-window-api.ts`（該当実装）を更新し renderer 型を整合。
  8. renderer 側 (`src/App.tsx`, `src/HomeApp.tsx`, `src/home-components.tsx`, `src/session-components.tsx`)：選択時の詳細取得、監査詳細遅延取得、メッセージ表示を分割APIへ。
  9. 既存 V1 書き込み互換の維持範囲を `src-electron/main.ts` と storage 初期化順で調整し、移行完了後にV2優先へ切替。

## 5. 未解決質問
- 設計内で決められる事項
  - V1 `stream_json` を保持する上限（全件保持、要約保持、TTL削除）。
  - audit detail を `audit_logs.id` に対する 1:1 分離にするか 1:N 可変構造にするか。
  - 検索インデックスの最適化方針（`session_messages` は `session_id + sequence` を必須とするか、追加条件列まで複合）。
  - 不正/壊れた JSON の保存方式（raw文字列列追加 or 破棄 + エラーログ）。
- ユーザー確認が必要になりうる事項
  - 移行直後の短期運用で `project/character memory` データを参照機能まで維持する必要があるか。
  - 既存 V1 DB の互換期間をどこまで許容するか（V1直起動許容 / migration必須 / read fallback）。
  - 監査ログを modal で即時全文表示する要件を維持しつつ、UX遅延ロードを許容するか。
  - 移行対象外データのアーカイブ要否（運用上の再取得可能性）。

# 次ファイル/コマンド
- `docs/design/database-v2-migration.md` の dry-run / dry-run レポート雛形整合を最終確定。
- `docs/design/database-schema.md` と実装の `database-schema-v2.ts` を一致させた上で DDL 差分チェック。
- `src-electron/main-query-service.ts` と `src/HomeApp.tsx` を中心に、messages/audit の呼び出し順序図を更新。
