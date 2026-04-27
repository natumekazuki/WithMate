# i-v2-review3 review

## Findings

### [P0] V2 DB startup still instantiates V1 `SessionStorage` and fails before the app can open

- Files:
  - `src-electron/main.ts:674`
  - `src-electron/main.ts:678`
  - `src-electron/main.ts:682`
  - `src-electron/main.ts:1431`
  - `src-electron/main.ts:1820`
  - `src-electron/persistent-store-lifecycle-service.ts:56`
  - `src-electron/persistent-store-lifecycle-service.ts:62`
  - `src-electron/session-storage.ts:52`
  - `src-electron/session-storage.ts:77`
  - `src-electron/database-schema-v2.ts:30`

`resolveAppDatabasePath()` now selects `withmate-v2.db` when it exists, but `main.ts` still wires `PersistentStoreLifecycleService` with V1 `SessionStorage` / `AuditLogStorage`. During `initialize()`, the lifecycle calls `sessionStorage.listSessions()`. V1 `SessionStorage` selects `messages_json` and `stream_json`, while V2 `sessions` intentionally does not contain those columns. A migrated user with `withmate-v2.db` present will hit SQLite `no such column: messages_json` during startup.

Targeted reproduction:

```text
npx tsx -e "<create V2 schema DB, instantiate SessionStorage, call listSessions()>"
```

Result:

```text
src-electron/session-storage.ts:392
Error: no such column: messages_json
code: ERR_SQLITE_ERROR
```

This is a same-plan required fix. The V2 path selection slice must be integrated with storage lifecycle selection before it can ship. Recommended same-plan fix: introduce an explicit runtime DB mode or bundle factory that selects `SessionStorageV2Read` / `AuditLogStorageV2Read` for read paths when the selected file is V2, and prevents V1 write-capable stores from mutating V2 schema until V2 write-path is implemented. Add an integration test that creates `withmate-v2.db` with `CREATE_V2_SCHEMA_SQL`, runs the lifecycle factory path, and verifies startup reads sessions without touching V1 `messages_json` / `stream_json`.

### [P1] V2-selected runtime can write V1 audit/session columns into the V2 file instead of preserving the V2 source of truth

- Files:
  - `src-electron/main.ts:678`
  - `src-electron/main.ts:682`
  - `src-electron/audit-log-storage.ts:159`
  - `src-electron/audit-log-storage.ts:205`
  - `src-electron/audit-log-storage.ts:230`
  - `docs/design/database-v2-migration.md:213`
  - `docs/design/database-v2-migration.md:215`

Even after the startup crash is addressed, the same lifecycle wiring would give V2 DB paths to V1 write-capable storage classes. `AuditLogStorage` calls `ensureColumns()` and can add V1 heavy detail columns such as `logical_prompt_json`, `transport_payload_json`, `assistant_text`, `operations_json`, `raw_items_json`, and `usage_json` to V2 `audit_logs`; `SessionStorage` would also write V1 `messages_json` / `stream_json` if those columns were added to avoid the crash. That contradicts the documented first slice policy: use V2 read-path when `withmate-v2.db` exists, but do not switch V2 runtime write-path yet.

This is a same-plan required fix because it is the same integration boundary as the startup selection. Recommended same-plan fix: make V2 runtime mode read-only for V2 normalized domains that lack write-path support, or route write operations through V1 DB until a V2 write adapter exists. If supporting live writes to V2 is intended in this slice, that is a larger scope than slices 1-3 and should become a separate implementation plan covering V2 session/audit write adapters, schema invariants, and migration/update tests.

### [P2] `AuditLogStorageV2Read.listSessionAuditLogs()` still loads detail payload for the whole audit list

- Files:
  - `src-electron/audit-log-storage-v2-read.ts:51`
  - `src-electron/audit-log-storage-v2-read.ts:67`
  - `src-electron/audit-log-storage-v2-read.ts:69`
  - `src-electron/audit-log-storage-v2-read.ts:70`
  - `docs/design/data-loading-performance-audit.md:146`
  - `docs/plans/20260427-identify-data-loading-optimizations/plan.md:6`

The adapter restores the existing `AuditLogEntry[]` shape, but it does so with a `LEFT JOIN audit_log_details` that selects `logical_prompt_json`, `transport_payload_json`, `assistant_text`, `raw_items_json`, and `usage_json` for every audit log in the session. That means the current audit list path still reads the heavy payload the plan calls out as the optimization target. The tests validate DTO reconstruction, but they do not guard that the summary/list path avoids detail table payload.

Classification: not a startup blocker, but do not treat checkpoint 6 as complete from this slice. If existing IPC must keep returning full `AuditLogEntry[]` in this slice, this should be recorded as a new-plan follow-up for a separate validation axis: audit-log pagination and lazy detail API. If the current slice is expected to satisfy "no heavy payload on summary paths", fix in the same plan by splitting summary list from detail fetch and adding a test that fails when `audit_log_details` is touched by the summary path.

## TDD Evidence

- Existing tests cover `resolveAppDatabasePath()` path priority.
- Existing tests cover `SessionStorageV2Read` DTO reconstruction and verify session summary avoids message/artifact reads by query shape.
- Existing tests cover `AuditLogStorageV2Read` DTO reconstruction, detail fallback, usage fallback, and operation order.
- Missing: lifecycle integration test for `withmate-v2.db` selection plus `PersistentStoreLifecycleService.initialize()`.
- Missing: guard test that V2-selected runtime does not instantiate V1 write-capable storages against V2 schema.
- Missing or intentionally deferred: audit summary/list path test that proves heavy detail payload is not loaded.

## Slice / Design Assessment

- Slice 1 (`app-database-path`) is too narrow by itself: selecting `withmate-v2.db` without lifecycle storage selection creates a runtime regression.
- Slice 2 (`SessionStorageV2Read`) matches the existing `SessionSummary` / `Session` shape and correctly returns `stream: []` for V2.
- Slice 3 (`AuditLogStorageV2Read`) matches the existing `AuditLogEntry` shape, but it does not yet deliver the audit-log list loading optimization because it reads detail payload eagerly.
