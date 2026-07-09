# i-v2-review3 result

- Status: blocking findings returned
- Review target: V2 runtime read-path slices 1-3

## Findings Summary

1. `[P0]` V2 DB startup still instantiates V1 `SessionStorage` and fails with `no such column: messages_json`.
2. `[P1]` V2-selected runtime can still instantiate V1 write-capable storages against the V2 DB, risking V1 column drift in V2 schema.
3. `[P2]` `AuditLogStorageV2Read.listSessionAuditLogs()` reconstructs DTOs but still loads detail payload for the whole audit list.

## Same-plan Required Fixes

- Add V2-aware lifecycle/storage selection before shipping `withmate-v2.db` startup selection.
- Prevent V1 write-capable session/audit storages from opening the V2 DB unless V2 write-path is explicitly implemented.
- Add lifecycle integration coverage for a real V2 schema DB selected at startup.

## New-plan Follow-up

- Audit-log pagination and lazy detail loading should be a separate plan if the existing `AuditLogEntry[]` IPC contract must remain unchanged in this slice. The independent validation axis is UI/API contract change plus detail-fetch paging behavior.

## Validation Performed

- Inspected target files and related lifecycle/design docs.
- Ran a targeted reproduction that creates a V2 schema DB, instantiates current `SessionStorage`, and calls `listSessions()`.
- Reproduction failed with `ERR_SQLITE_ERROR: no such column: messages_json`, confirming the startup lifecycle risk.
