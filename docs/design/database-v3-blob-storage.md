# Database V3 Blob Storage

- 作成日: 2026-05-02
- 対象: V3 DB と DB 外 compressed blob store
- 関連: `docs/design/database-schema.md`, `docs/design/database-v2-migration.md`, `docs/design/audit-log.md`, `docs/design/companion-mode.md`

## Goal

V3 では、一覧・検索・削除判定に必要な軽量 metadata は SQLite に残し、prompt / provider response / raw items / diff rows / artifact detail のような重い文字 payload は DB 外の compressed blob として保存する。

これにより、SQLite 本体と WAL の肥大化、起動時・一覧取得時・IPC での巨大 payload 搬送を避ける。

## Decisions

- V3 DB filename は `withmate-v3.db` とする。
- V3 runtime の DB 選択優先順は `withmate-v3.db` -> `withmate-v2.db` -> `withmate.db` とする。
- V3 migration は app 起動時に暗黙実行しない。
- 重い raw/detail 文字 payload は DB `TEXT` へ保存せず、DB 外 blob store へ圧縮保存する。
- 標準の read path は compressed blob を Main Process 内でメモリ展開する。
- 一時ファイルへの展開は標準経路にしない。
- 一時ファイル展開が必要な debug/export は、通常 UI と別の明示操作として扱う。
- Session / Companion を削除する場合、関連 audit / artifact / merge diff blob も削除対象にする。
- CompanionAudit は V3 scope で正式に追加する。

## Storage Overview

保存先:

```text
<userData>/
  withmate-v3.db
  blobs/
    v3/
      <shard>/
        <blob_id>.<codec>
```

`blob_id` は外部入力や元 file path を含めない opaque id とする。blob file path は DB に保存せず、`blob_id` と `codec` から BlobStore が決定する。

## Blob Metadata

V3 DB は blob 実体ではなく、blob metadata と owner からの参照だけを持つ。

### `blob_objects`

| Column | Type | Meaning |
| --- | --- | --- |
| `blob_id` | `TEXT PRIMARY KEY` | blob id |
| `codec` | `TEXT` | `br` または `gzip` |
| `content_type` | `TEXT` | `text/plain` または `application/json` |
| `original_bytes` | `INTEGER` | 展開後 byte size |
| `stored_bytes` | `INTEGER` | 圧縮後 byte size |
| `raw_sha256` | `TEXT` | 展開前 text bytes の hash |
| `stored_sha256` | `TEXT` | 圧縮済み bytes の hash |
| `state` | `TEXT` | `ready` / `delete_pending` |
| `created_at` | `TEXT` | 作成時刻 |
| `last_verified_at` | `TEXT` | 最終検証時刻 |

`state = ready` の row だけが通常 read path の対象になる。`delete_pending` は commit 後 file delete に失敗した場合の retry 対象とする。

## Blob Store API

BlobStore は Main Process 専用 API とする。Renderer は blob path を受け取らない。

```ts
type BlobRef = {
  blobId: string;
  codec: "br" | "gzip";
  contentType: "text/plain" | "application/json";
  originalBytes: number;
  storedBytes: number;
  rawSha256: string;
  storedSha256: string;
};

type BlobReadOptions = {
  maxOriginalBytes?: number;
};

type TextBlobStore = {
  putText(input: { contentType: BlobRef["contentType"]; text: string }): Promise<BlobRef>;
  putJson(input: { value: unknown }): Promise<BlobRef>;
  getText(blobId: string, options?: BlobReadOptions): Promise<string>;
  getJson<T>(blobId: string, options?: BlobReadOptions): Promise<T>;
  stat(blobId: string): Promise<BlobRef | null>;
  markDeletePending(blobIds: readonly string[]): Promise<void>;
  deleteUnreferenced(blobIds: readonly string[]): Promise<BlobGcReport>;
  collectGarbage(input: { dryRun?: boolean; graceMs?: number }): Promise<BlobGcReport>;
};
```

既存の Session / Audit storage は同期 API 前提のため、V3 の同期 storage では同じ file format を使う `SyncTextBlobStore` を利用する。async / sync の blob store は `blob_id`, shard path, codec, metadata JSON を共有し、相互に読み書きできることを前提にする。

`getText()` / `getJson()` は `original_bytes` が `maxOriginalBytes` を超える場合、全文展開せずに domain service へ上限超過を返す。UI は preview / truncated 表示へ fallback する。

## DB Text Boundary

V3 の DB `TEXT` は preview / summary / metadata に限定し、full raw/detail payload は blob を正本にする。

| Category | Limit | Notes |
| --- | --- | --- |
| `*_preview` | 500 chars | message body / assistant text / error / role などの短い表示用 |
| operation `summary` | 500 chars | command output や raw log は入れない |
| `details_preview` | 500 chars | full operation details は `details_blob_id` から読む |
| `*_summary_json` | 8192 chars | counts / path / status / short preview だけを許可 |

V3 schema では、`text`, `message_text`, `body`, `content`, `artifact_json`, `diff_snapshot_json`, `diff_rows_json`, `logical_prompt_json`, `transport_payload_json`, `assistant_text`, `raw_items_json`, `operations_json`, `details`, `error_message`, `prompt_text`, `response_text`, `payload_json`, `raw_json` を重い payload column 名として禁止する。

## Write Atomicity

SQLite transaction と file write は完全には同一 transaction にできないため、V3 は次の順で整合を守る。

1. compressed bytes を staging file へ書く。
2. hash と byte size を検証する。
3. staging file を final blob path へ atomic rename する。
4. DB transaction で `blob_objects` と owner row の blob ref を保存する。
5. DB transaction に失敗した場合、final blob は orphan として GC 対象にする。

DB commit 前に blob file を削除しない。削除系では DB commit 後に file delete を行い、失敗した blob は `delete_pending` として retry する。

## V3 Schema Boundary

### Session

`sessions` は V2 と同様に header / counters / preview を持つ。

`session_messages` は message 本文を直接持たず、bounded preview と blob ref を持つ。

| Column | Meaning |
| --- | --- |
| `text_preview` | 一覧・初期表示用の短い本文 |
| `text_blob_id` | full message text blob |
| `text_original_bytes` | 展開後 size |
| `text_stored_bytes` | 圧縮後 size |
| `artifact_available` | artifact の有無 |

`session_message_artifacts` は artifact summary と blob ref を持つ。

| Column | Meaning |
| --- | --- |
| `message_id` | `session_messages(id)` |
| `artifact_summary_json` | `kind`, `title`, `activity_count`, `changed_file_count`, `preview` などの小さい summary |
| `artifact_blob_id` | full `MessageArtifact` blob |

`artifact_summary_json` に full `MessageArtifact` を入れない。`diffRows`, full command log, full artifact body は禁止し、必要時は `artifact_blob_id` から読む。

### Session Audit

SessionAudit は V2 の summary/detail/lazy load 境界を維持し、detail payload を blob ref 化する。

`audit_logs`:

- `session_id`
- `created_at`
- `phase`
- `provider`
- `model`
- `reasoning_effort`
- `approval_mode`
- `thread_id`
- `assistant_text_preview`
- `operation_count`
- `raw_item_count`
- token count
- `has_error`
- `error_message_preview`
- `detail_available`

`audit_log_details`:

- `audit_log_id`
- `logical_prompt_blob_id`
- `transport_payload_blob_id`
- `assistant_text_blob_id`
- `raw_items_blob_id`
- `usage_metadata_json`
- `usage_blob_id`

`audit_log_operations`:

- `audit_log_id`
- `seq`
- `operation_type`
- `summary` (500 chars max)
- `details_preview` (500 chars max)
- `details_blob_id`

### Companion

V3 では Companion tables を V3 schema source に昇格する。現行の `CompanionStorage` constructor 内 schema 作成は、V3 では `database-schema-v3.ts` の SQL 定数へ寄せる。

`companion_messages` は `session_messages` と同様に `text_preview`, `text_blob_id`, `text_original_bytes`, `text_stored_bytes`, `artifact_available` を持つ。full artifact は `companion_message_artifacts.artifact_blob_id` に逃がし、DB には `artifact_summary_json` だけを置く。

`companion_merge_runs` は merge/discard history の summary だけを持つ。

- `operation`
- `selected_paths_json`
- `changed_files_summary_json`
- `sibling_warnings_summary_json`
- `diff_snapshot_blob_id`

`changed_files_summary_json` は `path`, `status`, addition/deletion count, binary flag などの小さい summary として DB に残す。`sibling_warnings_summary_json` も warning code / path / short message に限定する。full `ChangedFile[]`, hunks, `diffRows`, terminal output は `diff_snapshot_blob_id` から読む。

### Companion Audit

CompanionAudit は SessionAudit と同じ DTO 境界を持つが、SQLite FK cascade を単純にするため table は分ける。

- `companion_audit_logs`
- `companion_audit_log_details`
- `companion_audit_log_operations`

`companion_audit_logs.session_id` は `companion_sessions(id) ON DELETE CASCADE` とする。共通 UI / IPC shape は service layer で吸収する。

`companion_audit_logs` は `audit_logs` と同じ summary 列を持つ。`assistant_text_preview`, `error_message_preview`, counts, token counts, `detail_available` だけを DB に置き、assistant full text は持たない。

`companion_audit_log_details` は `logical_prompt_blob_id`, `transport_payload_blob_id`, `assistant_text_blob_id`, `raw_items_blob_id`, `usage_metadata_json`, `usage_blob_id` を持つ。prompt / transport payload / raw items の JSON 本体は DB に置かない。

`companion_audit_log_operations` は `operation_type`, `summary`, `details_preview`, `details_blob_id` を持つ。`summary` と `details_preview` は上限つきで、full details は blob に置く。

## Read Path

### Summary

一覧 API は blob を読まない。

- Session summary
- Companion summary
- Audit summary page
- Merge run history

### Detail

detail API は section 単位で blob を読む。

- `logicalPrompt`
- `transportPayload`
- `assistantText`
- `rawItems`
- `operationDetails`
- `messageArtifact`
- `diffSnapshot`

巨大 section は一括 IPC しない。`original_bytes` に基づいて preview / pagination / max size guard を適用する。

## Delete Policy

現時点の方針では、削除済み Session / Companion の audit と raw/detail blob は保持しない。

### Session Delete

1. 対象 session に紐づく message / artifact / audit blob ids を収集する。
2. DB transaction で `sessions` を削除する。
3. FK cascade で DB row を削除する。
4. commit 後、収集済み blob ids を `deleteUnreferenced()` へ渡す。
5. 削除失敗分は `delete_pending` として retry する。

### Companion Delete

1. 対象 companion session に紐づく message / merge run / companion audit blob ids を収集する。
2. DB transaction で `companion_sessions` を削除する。
3. FK cascade で関連 row を削除する。
4. commit 後、収集済み blob ids を削除する。

`clearSessions()`, `clearAuditLogs()`, `clearCompanions()`, Settings reset も同じ cleanup service を使う。

## Garbage Collection

GC は DB を正本として file store を掃除する。

- DB 上の ready blob refs を live set とする。
- blob file があるが live set に無い場合、grace period 後に削除する。
- `delete_pending` は優先削除する。
- `blob_objects` はあるが file が無い場合、missing blob として repair report に出す。
- 通常起動時は軽量 GC のみ行う。
- `repairV3Blobs()` は DB 参照を live set として dry-run / cleanup report を返す。
- Settings から手動 repair / dry-run GC を実行できる余地を残す。

## Migration

V3 migration は専用 script にする。

- `scripts/migrate-database-v2-to-v3.ts --dry-run --v2 <path>`
- `scripts/migrate-database-v2-to-v3.ts --write --v2 <path> --v3 <path> --blob-root <path> [--overwrite]`

### Dry Run Report

- V2 table counts
- blob 化対象の estimated bytes
- estimated compressed bytes
- broken JSON
- skipped rows
- Companion table counts
- audit detail / artifact / diff snapshot の件数

### Write Mode

- V2 DB は read-only source として扱う。
- V3 DB と `blobs/v3.staging/` にだけ書く。
- payload は row 単位で読み、全件を同時に保持しない。
- staging blob manifest を検証してから `blobs/v3/` へ promote する。
- 失敗時は V3 DB と staging blob を削除し、V2 DB は変更しない。

V1-only install は当面 V1 のまま起動する。必要になった時点で V1 -> V2 -> V3 の明示 migration chain を提供する。

## UI / IPC Impact

- Audit Log modal は summary page を先に出し、detail fold 展開時に `logical` / `transport` / `response` / `operations` / `raw` の section detail だけを読む。互換用 full detail API は残すが、通常 UI は section API を使う。
- Raw Items は全文 state に入れず、preview first とする。
- Session metadata 用の skills / custom agents / composer preview は full session hydrate を避け、`SessionSummary` の `workspacePath` / `allowedAdditionalDirectories` だけで解決する。
- Diff Window は token 経由の lazy window を維持し、Message artifact は initial session hydrate で full diff rows を読まない。
- Session / Companion message artifact は `getSessionMessageArtifact(sessionId, messageIndex)` / `getCompanionMessageArtifact(sessionId, messageIndex)` で Details 展開時に full artifact blob を読む。
- Companion Review の merge run history は `CompanionMergeRunSummary` を返し、polling snapshot では `diffSnapshot` blob を復元しない。terminal / inactive read-only 表示では最新 run の full `diffSnapshot` を復元して `changedFiles` を作る。

## Alternatives

### SQLite `BLOB` column に圧縮 bytes を保存する

DB/file の原子性は扱いやすいが、SQLite 本体と WAL の肥大化は残るため不採用。

### V2 detail table に gzip text を保存する

実装は小さいが、DB に raw/detail payload を持たないという V3 目的を満たさないため不採用。

### SessionAudit と CompanionAudit を単一 polymorphic table にする

共通 query は書きやすいが、SQLite FK cascade が弱くなり削除時 cleanup が複雑になるため、V3 初期案では採用しない。

### 一時ファイル展開を標準 read path にする

大容量閲覧には強いが、raw payload の露出面が増えるため不採用。標準 read path はメモリ展開とし、上限超過時は preview / pagination / 明示 export に逃がす。

## Risks

| Risk | Mitigation |
| --- | --- |
| DB commit と blob write の原子性が完全ではない | staging write、hash 検証、DB `blob_objects`、orphan GC |
| 削除時に blob が残る | 削除前 blob id 収集、commit 後 delete、`delete_pending` retry |
| missing blob で UI が壊れる | detail hydration fallback と repair report |
| メモリ展開で Main Process が詰まる | `maxOriginalBytes` guard、section API、preview first |
| IPC payload が巨大化する | section 単位 API、raw pagination、renderer state に全文保持しない |
| backup / restore が DB file だけでは不完全 | V3 では DB と `blobs/v3/` を同じ永続化単位として扱う |
| file path / payload 漏えい | userData 配下固定、opaque blob id、path を Renderer に渡さない |

## Implementation Slices

1. `database-schema-v3.ts` と V3 DB selection を追加する。完了。
2. `TextBlobStore` / `SyncTextBlobStore` と `blob_objects` metadata を実装する。完了。
3. V3 SessionStorage を message text / artifact blob ref 対応にする。完了。
4. V3 Audit storage を section blob ref 対応にする。完了。
5. V3 lifecycle で `SessionStorageV3` / `AuditLogStorageV3` を選択する。完了。
6. Companion tables を V3 schema source に昇格する。完了。
7. CompanionAudit storage / runtime write path を追加する。完了。
8. IPC / renderer の重い payload を section / summary lazy load へ移行する。Audit detail section API、metadata query の summary 化、Companion merge run history summary 化、Session / Companion message artifact detail API は完了。
9. V2 -> V3 migration script を追加する。完了。
10. delete cleanup / blob GC / repair report を追加する。完了。
11. database schema doc と manual test checklist を同期する。完了。

## Validation Strategy

- schema test: V3 schema に raw/detail `TEXT` column が混入していないこと。
- blob store test: compression / hash / max size guard / missing blob fallback。
- audit storage test: summary は blob を読まず、section detail だけ blob を読むこと。
- session storage test: initial hydrate が full artifact blob を読まず、message artifact detail API だけが full artifact を返すこと。
- companion storage test: merge diff snapshot が blob ref 化され、history summary では full diff snapshot を返さないこと。
- deletion test: Session / Companion delete 後に DB row と blob refs が消えること。
- GC test: orphan / missing / delete_pending の report と cleanup。
- migration test: V2 detail JSON / artifact JSON / diff snapshot が V3 blob に移ること。
- IPC/renderer test: raw detail の巨大 payload を一括 state に載せないこと。
