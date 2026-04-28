# データ読み込み/レンダリング負荷の回収ポイント調査（全体探索）

- 作成日: 2026-04-27
- 対象: WithMate 全体（Main Process / Renderer / SQLite schema）
- 目的: 「一度に大きなデータを読み込んでクラッシュする」事象を避けるため、段階読み込み・軽量化の回収ポイントを整理する

## 結論サマリ（優先度順）

1. **`sessions` の全量取得で `messages_json` / `stream_json` を同時読込している箇所を、summary 参照に置換する。**
2. **監査ログ（`audit_logs`）の「全件 + 重い列」読込を、ページング + 詳細遅延取得に分割する。**
3. **Memory Management はスナップショット全件返却をやめ、ドメイン別・ページ別 API に分割する。**
4. **メッセージ/監査ログ UI に virtualization（表示範囲のみ描画）を導入する。**
5. **巨大 JSON カラムを持つテーブルは「一覧用軽量列」と「詳細列」を分離する。**

---

## 1. 現状のボトルネック（コード根拠あり）

### 1-1. `sessions` 全量取得が重い（メッセージ履歴を毎回抱える）

- `SessionStorage.listSessions()` は `LIST_SESSIONS_SQL` を使い、`messages_json` と `stream_json` を含む全列を全 session 分 `.all()` で取得している。  
- さらに `rowToSession()` で各 row の JSON を `JSON.parse` しており、セッション数 x 履歴サイズ分のCPU/メモリを消費する。

**該当実装**

- `LIST_SESSIONS_SQL` は `SESSION_SELECT_COLUMNS`（`messages_json`, `stream_json` 含む）を全件取得。  
- `listSessions()` が `.all()` をそのまま返却変換。  
- `parseSessionJson()` / `rowToSession()` で JSON 全量デシリアライズ。  

**回収ポイント**

- `listSessions()` の利用箇所で、本当に履歴本体が必要かを分類し、**summary だけで足りる経路を `listSessionSummaries()` に統一**する。
- `sessions` への一覧用途では `messages_json`, `stream_json` を取得しないようにする（既存 `listSessionSummaries()` を優先利用）。

---

### 1-2. Memory Management が「全ドメイン全件」を一括取得している

- `MemoryManagementService.getSnapshot()` は以下を一括で構築する。  
  - 全 sessions（`listSessions()`）
  - 全 session memories（`listSessionMemories()`）
  - 全 project scopes + 各 scope の全 entries
  - 全 character scopes + 各 scope の全 entries
- つまりデータ量が増えるほど初回ロードで巨大オブジェクトを作りやすい。

**該当実装**

- `getSnapshot()` 内で全件列挙 + map/filter。  
- Main 側 DI でも `listSessions()` を渡しており、ここで重い session 本体を巻き込む。

**回収ポイント**

- `getSnapshot()` を廃止し、以下 API に分割する。  
  - `getSessionMemoriesPage(filter, cursor, limit)`
  - `getProjectScopesPage(...)`
  - `getProjectMemoryEntriesPage(scopeId, cursor, limit)`
  - `getCharacterScopesPage(...)`
  - `getCharacterMemoryEntriesPage(scopeId, cursor, limit)`
- 画面では「表示中タブのみ読込」「スクロールで追加取得」に変更する。

**実装状況**

- `getMemoryManagementPage({ domain, cursor, limit, searchText, sort, ...filters })` を追加し、Renderer / IPC の初期取得と Reload は page API 経由へ移行済み。
- 既存互換用の `getMemoryManagementSnapshot()` は残している。
- `session_memories` / `project_memory_entries` / `character_memory_entries` は storage query 側で search / filter / sort / `LIMIT` / `OFFSET` / count を処理し、`getPage()` は通常経路で `getSnapshot()` を通らない。検索は `instr(lower(...), ?)` と `json_each(...)` による literal search とし、`%` / `_` を wildcard として扱わない。
- `getSnapshot()` は既存互換用に残し、将来的な FTS / 追加 index はデータ増加時の follow-up として扱う。

---

### 1-3. 監査ログが全件・重列を毎回取得している

- V1 `AuditLogStorage.listSessionAuditLogs(sessionId)` は対象 session の監査ログを `ORDER BY id DESC` で**全件**取得している。
- 列には `logical_prompt_json`, `transport_payload_json`, `operations_json`, `raw_items_json` があり、重くなりやすい。
- Renderer 側でも session 変更や refresh signature 変更時に毎回この API を叩くため、データ量が多い session でコストが大きい。

**該当実装**

- `listStatement` の SQL が LIMIT なし。  
- `listSessionAuditLogs()` が `.all(sessionId)`。  
- V2 runtime の `App.tsx` は `withmateApi.listSessionAuditLogSummaries(selectedSession.id)` を再読込し、detail 展開時だけ `getSessionAuditLogDetail(sessionId, auditLogId)` を呼ぶ。

**回収ポイント**

- `audit_logs` を 2 段階取得にする。  
  1) 一覧: 軽量列のみ（id, created_at, phase, provider, model, reasoning_effort, approval_mode, usage 要約）+ LIMIT  
  2) 詳細: 展開時に `logical_prompt_json` / `operations_json` / `raw_items_json` 等を単体取得
- UI 上は「最新 N 件表示 + もっと読む」を標準化する。

---

### 1-4. メッセージ描画が全件レンダリング（virtualization 未導入）

- `SessionMessageColumn` は `messages.map(...)` で全文描画する。
- 1 メッセージ内にも `changedFiles.map`, `diffRows`, `runChecks`, `operationTimeline` などが含まれるため、DOM ノード数が増えやすい。

**該当実装**

- メッセージ列で `messages.map(...)` を直接実行。  
- アーティファクト展開時に変更ファイル・操作履歴をすべて描画。

**回収ポイント**

- `react-virtual` 等による仮想スクロールを導入し、可視領域前後だけ描画する。
- 折りたたみ未展開時は重いサブツリー（diff 断片、operation 詳細）を mount しない。

---

### 1-5. Memory Management の検索前処理が全件連結文字列を生成

- `buildFilteredMemoryManagementSnapshot()` の準備段階で、各メモリ要素の検索キーを全項目連結して作る。
- データ規模が大きいと文字列連結/保持コストが急増し、GC 負荷も増える。

**該当実装**

- `getPreparedSnapshot()` で session/project/character 全件に `buildSearchKey(...)` を実施。
- `WeakMap` キャッシュはあるが、スナップショット自体が更新されると再構築される。

**回収ポイント**

- Main 側 page API へ検索を寄せる。さらに SQLite query level では `LIKE` + index または FTS テーブルを検討する。
- Renderer での検索キー全件構築をやめ、ページ単位で必要分だけ計算する。

---

## 2. DB設計面の回収ポイント（構造的対策）

### 2-1. `sessions` を「ヘッダ」と「履歴」に分割する

現状は `sessions` 1 row に `messages_json` / `stream_json` を抱えており、一覧系処理と履歴本体が密結合になっている。

**提案**

- `sessions`（軽量ヘッダ）
- `session_messages`（1 message = 1 row、`session_id`, `seq`, `role`, `text`）
- `session_message_artifacts`（1 message artifact = 1 row、重い artifact payload を展開時取得）

これにより、一覧/集計処理で巨大 JSON を触らない設計にできる。

V2 では独り言機能を削除するため、V1 `sessions.stream_json` は legacy data として V1 DB に残し、V2 正本 schema には持ち込まない。V2 の確定 schema は `src-electron/database-schema-v2.ts` と `docs/design/database-v2-migration.md` を参照する。

runtime path では、有効な `withmate-v2.db` が存在する場合に V2 `sessions` から session summary を復元する。summary 取得では `session_messages` / `session_message_artifacts` を読まず、session detail 取得時だけ対象 session の message row と artifact row を読む。V2 DB では V1 `SessionStorage` を開かず、`SessionStorageV2Read` が V2 split schema の read / write を担当する。session write は `sessions` header と対象 session の message / artifact rows を transaction 内で更新し、`stream` は V2 へ保存しない。

### 2-2. `audit_logs` に一覧用サマリ列を持つ

現状の `audit_logs` は詳細情報を毎回同時に持ち回る設計。

**提案**

- 一覧用: `assistant_text_preview`, `operation_count`, `raw_item_count`, `input_tokens`, `cached_input_tokens`, `output_tokens`, `has_error`, `error_message`
- timeline 用: `audit_log_operations`（1 operation = 1 row）
- 詳細用: `audit_log_details` に `logical_prompt_json`, `transport_payload_json`, `assistant_text`, `raw_items_json`, `usage_json` を退避する

runtime path では、audit log modal 初期表示は `AuditLogSummary[]` を取得する。summary は `audit_logs` の一覧列と `audit_log_operations` だけを読み、`audit_log_details` は読まない。Logical Prompt / Transport Payload / Response / Raw Items などの detail section を開いた時だけ `getSessionAuditLogDetail(sessionId, auditLogId)` で対象 row の `audit_log_details` を読む。既存互換用の `listSessionAuditLogs(sessionId)` は残し、V2 DB では V1 `AuditLogStorage` を開かず `AuditLogStorageV2Read` が V2 split schema の read / write を担当する。audit write は summary / detail / operations を transaction 内で保存・置換し、`sessions.audit_log_count` も同じ transaction で更新する。

V2 DB では legacy memory table を作らないため、memory 系 storage は read-only/no-op adapter に差し替える。これにより V2 read-path 起動時に `session_memories`、`project_scopes`、`character_scopes` などを暗黙作成しない。

### 2-3. 古いデータの保持ポリシーを明確化

- 監査ログ `raw_items_json` は肥大化しやすいため、保存期限・件数上限・圧縮方針を定義する。
- セッション履歴も「最新N件フル保持 + それ以前サマリ化」などのアーカイブ戦略を導入する。

---

## 3. 具体的な実装タスク案（段階導入）

### Phase 1（即効、低リスク）

1. `listSessions()` の利用箇所を棚卸しし、履歴不要経路を `listSessionSummaries()` へ差し替え。  
2. audit log modal 初期表示を `listSessionAuditLogSummaries(sessionId)` に変更し、detail section 展開時だけ `getSessionAuditLogDetail(sessionId, auditLogId)` を呼ぶ。
3. `listSessionAuditLogSummaries(sessionId)` に `limit` / `cursor` を追加し、「最新50件 + 追加読込」に変更。
4. Memory Management API をドメイン単位 endpoint に分解（まず session memory から）。

### Phase 2（中期）

1. Message List / Audit Log List の virtualization 導入。  
2. Memory Management 検索の FTS / 追加 index を必要に応じて検討する。
3. 大きい JSON を展開時取得に変更（詳細 API 化）。

### Phase 3（構造改革）

1. `sessions` の履歴分離（`session_messages` / `session_message_artifacts`）。  
2. `audit_logs` 詳細分離（`audit_log_details` / `audit_log_operations`）。  
3. 長期保持ポリシー（TTL、上限件数、圧縮）を仕様化。

---

## 4. 影響範囲と確認観点

### 4-1. 影響範囲

- Main Process: storage 層・query service・IPC contract
- Preload: API surface 追加（ページング/詳細取得）
- Renderer: Home / Session / Memory Management の読込シーケンス

### 4-2. 回帰確認（最低限）

- 大量データ（例: 200 session / 各500 message / audit log 5,000件）で:
  - 起動直後のメモリ使用量
  - Session 切替 latency
  - Audit Log モーダル初回表示時間
  - Memory Management 初回表示時間
- 既存の JSON migration / normalize の互換性（旧DB読み込み）

---

## 5. 優先回収チケット候補

1. **`perf/session-summary-first`**  
   `listSessions()` 呼び出し削減 + summary-first への統一。
2. **`perf/audit-log-pagination`**  
   監査ログ一覧をページング化し、詳細遅延取得へ。
3. **`perf/memory-management-sliced-loading`**  
   memory snapshot 全量返却を廃止し、ドメイン分割APIへ。
4. **`perf/message-list-virtualization`**  
   Message UI の仮想スクロール導入。
5. **`perf/storage-schema-split`**  
   `sessions`/`audit_logs` の詳細分離スキーマ移行。

---

## 6. 参照した主な実装箇所

- `src-electron/session-storage.ts`
- `src-electron/memory-management-service.ts`
- `src-electron/main.ts`
- `src-electron/audit-log-storage.ts`
- `src/App.tsx`
- `src/session-components.tsx`
- `src/memory-management-view.ts`
- `src/session-state.ts`
- `docs/design/database-schema.md`
