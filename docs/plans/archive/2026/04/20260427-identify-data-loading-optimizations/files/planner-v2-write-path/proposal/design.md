# V2 write path design note

- 作成日: 2026-04-28
- 対象: checkpoint 15 / V2 DB runtime write path

## Context

現在の V2 runtime は `withmate-v2.db` が有効な場合に V2 DB を選択し、session / audit の read adapter と memory no-op adapter を使う。session / audit の write-capable method は `main.ts` の writable guard で弾かれ、V2 DB では実行時 write ができない。

今回の slice は、既存 IPC / service contract を維持したまま、session / audit の既存 write API を V2 split schema へ対応させる。

指定された research summary `docs/plans/20260427-identify-data-loading-optimizations/files/researcher-v2-write-path/proposal/summary.md` は確認時点で存在しなかった。代替として active plan、既存 V2 read / migration summaries、disposable worktree の current code を参照した。

## Recommendation

- Design Gate: repo-sync-required
- 推奨実装: 既存 `SessionStorageV2Read` / `AuditLogStorageV2Read` に write method を追加して green 化し、必要なら後続 review で命名整理を別 slice に切る。
- 理由:
  - lifecycle / main の既存 import と read tests への影響を最小化できる。
  - V2 write path の目的は contract 復旧であり、大規模 rename は checkpoint 15 の必須条件ではない。
  - docs には「V2 runtime write path が有効化されたが、audit summary page / detail lazy load API は未実装」と境界を明記する。

## Raw Alternatives

### Alternative A: 既存 V2Read class に write method を追加

- pros:
  - 差分が小さい。
  - lifecycle の V2 選択ロジックを大きく変えない。
  - `main.ts` の writable guard は method presence で自然に通る。
- cons:
  - class / file 名の `Read` と実態がずれる。
- judgment:
  - 今回の Green 実装では最有力。命名負債は Review で docs に残すか、follow-up に切る。

### Alternative B: `SessionStorageV2` / `AuditLogStorageV2` を新規追加

- pros:
  - 命名が正しい。
  - read-only adapter と write-capable adapter を明確に分離できる。
- cons:
  - 新規ファイル、import 切替、tests rename が増え、実装 slice のリスクが上がる。
  - 既存 read adapter と serialization helper の重複が発生しやすい。
- judgment:
  - checkpoint 15 だけなら過剰。独立 rename / cleanup は follow-up 候補。

### Alternative C: V1 `SessionStorage` / `AuditLogStorage` を schema branch 対応にする

- pros:
  - public class を増やさずに済む。
- cons:
  - V1 / V2 SQL が混ざり、V1 runtime regression のリスクが高い。
  - migration / read optimization の境界が曖昧になる。
- judgment:
  - 不採用。

## Session Write Mapping

### `sessions`

既存 `Session` の summary fields を `sessions` header に保存する。

- `message_count`: `session.messages.length`
- `audit_log_count`: 原則として既存値を保持するか、未取得時は `0`。audit write の future counter 更新と衝突しないよう、session write では audit log 件数を再計算しない。
- `last_active_at`: V1 と同様に `upsertSession` は `Date.now()`、`replaceSessions` は `Date.now() + length - index`。
- `stream`: V2 正本には保存しない。

### `session_messages`

- `seq`: message 配列 index。
- `role`: `user` / `assistant` のみ。`normalizeSession` 後の shape に従う。
- `text`: message text。
- `accent`: truthy なら `1`、それ以外は `0`。
- `artifact_available`: artifact があれば `1`。
- `created_at`: 現行 `Message` shape に timestamp がないため、空文字または session `updatedAt` を使う。migration 既定と合わせるなら空文字を優先。

### `session_message_artifacts`

- artifact がある message のみ insert。
- `artifact_json`: `JSON.stringify(message.artifact)`。

### Transaction

- `upsertSession`: transaction 内で header upsert、対象 session の messages delete、messages / artifacts 再 insert。
- `replaceSessions`: transaction 内で `DELETE FROM sessions`、全 session insert。
- `deleteSession`: `DELETE FROM sessions WHERE id = ?`。cascade に依存する。
- `clearSessions`: `DELETE FROM sessions`。cascade に依存する。

## Audit Write Mapping

### `audit_logs`

- `assistant_text_preview`: `assistantText` の短縮文字列。migration script と同じ基準があれば合わせる。なければ UI preview 用に先頭固定長を保存し、detail は `audit_log_details.assistant_text` に保持する。
- `operation_count`: `operations.length`
- `raw_item_count`: `rawItemsJson` が JSON 配列なら length、parse 不能なら `0`。
- token columns:
  - `input_tokens`: `usage?.inputTokens ?? null`
  - `cached_input_tokens`: `usage?.cachedInputTokens ?? null`
  - `output_tokens`: `usage?.outputTokens ?? null`
- `has_error`: `errorMessage` が空でなければ `1`。
- `detail_available`: `1`

### `audit_log_details`

- `logical_prompt_json`: `JSON.stringify(input.logicalPrompt)`
- `transport_payload_json`: `input.transportPayload ? JSON.stringify(input.transportPayload) : ""`
- `assistant_text`: `input.assistantText`
- `raw_items_json`: `input.rawItemsJson`
- `usage_json`: `input.usage ? JSON.stringify(input.usage) : ""`

### `audit_log_operations`

- `seq`: operations 配列 index。
- `operation_type`: `operation.type`
- `summary`: `operation.summary`
- `details`: `operation.details ?? ""`

### Transaction

- `createAuditLog`: transaction 内で summary insert、detail insert、operations insert、作成 row を `rowToAuditLogEntry` で返す。
- `updateAuditLog`: transaction 内で summary update。対象 id がない場合は throw。detail は upsert、operations は対象 id 分を delete して再 insert。
- `clearAuditLogs`: `DELETE FROM audit_logs`。cascade に依存する。

## Lifecycle Boundary

- V1 DB:
  - `SessionStorage`
  - `AuditLogStorage`
  - legacy memory storage
- V2 DB:
  - V2 session storage with read + write methods
  - V2 audit storage with read + write methods
  - `SessionMemoryStorageV2Read`
  - `ProjectMemoryStorageV2Read`
  - `CharacterMemoryStorageV2Read`
- memory:
  - V2 schema に legacy memory table は追加しない。
  - no-op / read-only adapter のままにする。

## Slice Boundaries

1. session Red: V2 write tests だけ。
2. session Green: V2 session write + lifecycle guard。
3. audit Red: V2 write tests だけ。
4. audit Green: V2 audit write + lifecycle guard。
5. Review: docs sync、full regression、active plan result/worklog 更新。

## Unresolved Questions

- 追加ユーザー質問: なし。
- 実装内判断として残る点:
  - `SessionStorageV2Read` / `AuditLogStorageV2Read` の rename を今回行うか。
  - `assistant_text_preview` の正確な切り詰め長を migration script と揃えるか、V2 runtime 固有 helper として定義するか。
  - `sessions.audit_log_count` を audit write 時に即時更新するか、後続 summary page slice で扱うか。

## Recommendation For Workspace vs Repo Sync

- 判定: repo-sync-required
- 理由:
  - runtime storage behavior が read-only から write-capable に変わる。
  - `docs/design/database-schema.md` の V2 Source Of Truth section にある read-only 記述を更新する必要がある。
  - `docs/design/database-v2-migration.md` に runtime write path の現在地を補足すると、migration script と runtime write の責務境界が保てる。

## Follow-up Candidate

- `SessionStorageV2Read` / `AuditLogStorageV2Read` を `SessionStorageV2` / `AuditLogStorageV2` に rename する cleanup。
- audit summary page / detail lazy load API の checkpoint 16。
- `sessions.audit_log_count` を summary page 用に厳密更新する counter policy。
