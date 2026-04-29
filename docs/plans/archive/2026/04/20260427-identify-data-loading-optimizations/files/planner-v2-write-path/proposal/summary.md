# planner-v2-write-path summary

- 作成日: 2026-04-28
- 対象 slice: V2 runtime write path
- 参照 worktree: `.codex-disposable/planner-v2-write-path/repo`

## Plan Tier 判断

- 判定: repo plan 内 same-plan slice
- 理由: active repo plan `docs/plans/20260427-identify-data-loading-optimizations/` の checkpoint 15「V2 DB runtime write path」に一致する。新規の独立目的ではなく、既存 V2 DB runtime 化の未完了 slice を進める作業である。
- repo plan 格上げ要否: 不要。すでに repo plan 管理下で、`questions.md` は `確認済み`。

## Goal

V2 `withmate-v2.db` を runtime 正本として選択した状態でも、既存 IPC / service contract を壊さずに session / audit の write-capable method を V2 schema へ保存できるようにする。

## Scope

- session:
  - `upsertSession`
  - `replaceSessions`
  - `deleteSession`
  - `clearSessions`
- audit:
  - `createAuditLog`
  - `updateAuditLog`
  - `clearAuditLogs`
- memory:
  - 引き続き no-op / read-only
  - legacy memory table は作らない
- compatibility:
  - V1 runtime は既存 `SessionStorage` / `AuditLogStorage` のまま維持
  - 既存 IPC / renderer shape は変更しない
- out of scope:
  - audit summary page
  - audit detail lazy load API
  - Memory table 再導入

## Design Gate

- 判定: repo-sync-required
- 理由: V2 runtime の保存責務が read-only から write-capable に変わるため、`docs/design/database-schema.md` の V2 runtime 説明と、必要に応じて `docs/design/database-v2-migration.md` の runtime boundary を同期する必要がある。IPC shape は変えないため、API 設計書の大幅更新は不要。

## Implementation Slices

### Slice 1 Red: session V2 write tests

- 目的: V2 session storage が split schema に書ける期待を先に固定する。
- dependencies: 既存 `SessionStorageV2Read` の read tests と V2 DDL。
- write set:
  - `scripts/tests/session-storage-v2-read.test.ts`
- test target:
  - `npx tsx --test scripts/tests/session-storage-v2-read.test.ts`
- acceptance criteria:
  - `upsertSession` が `sessions` / `session_messages` / `session_message_artifacts` に保存し、`getSession` で同じ `Session` shape を復元する期待が赤になる。
  - `replaceSessions` が既存 V2 session data を置換し、message / artifact orphan を残さない期待が赤になる。
  - `deleteSession` / `clearSessions` が cascade で message / artifact を消す期待が赤になる。
- TDD mode: Red

### Slice 2 Green: session V2 write implementation

- 目的: V2 session write を実装し、既存 V1 runtime と既存 read path を壊さない。
- dependencies: Slice 1。
- write set:
  - `src-electron/session-storage-v2-read.ts`
  - `src-electron/persistent-store-lifecycle-service.ts`
  - `src-electron/main.ts`
  - `scripts/tests/session-storage-v2-read.test.ts`
- test target:
  - `npx tsx --test scripts/tests/session-storage-v2-read.test.ts`
  - `npx tsx --test scripts/tests/persistent-store-lifecycle-service.test.ts`
  - `npx tsx --test scripts/tests/session-storage.test.ts`
- acceptance criteria:
  - V2 DB 選択時に `requireSessionStorageForWrite()` が read-only error を出さず、V2 storage を writable と判定する。
  - `upsertSession` は header を upsert し、該当 session の messages / artifacts を transaction 内で再構築する。
  - `replaceSessions` は session 系 table を transaction 内で全置換し、`last_active_at` 並び順を V1 と同等に維持する。
  - `deleteSession` / `clearSessions` は `ON DELETE CASCADE` を前提に detail table を残さない。
  - `Session.stream` は V2 正本には保存せず、read 復元では引き続き `[]`。
- TDD mode: Green

### Slice 3 Red: audit V2 write tests

- 目的: V2 audit storage が summary / detail / operations split schema に書ける期待を固定する。
- dependencies: 既存 `AuditLogStorageV2Read` read tests と Slice 2。
- write set:
  - `scripts/tests/audit-log-storage-v2-read.test.ts`
- test target:
  - `npx tsx --test scripts/tests/audit-log-storage-v2-read.test.ts`
- acceptance criteria:
  - `createAuditLog` が `audit_logs` / `audit_log_details` / `audit_log_operations` に保存し、`listSessionAuditLogs` で既存 `AuditLogEntry` shape を復元する期待が赤になる。
  - `updateAuditLog` が summary / detail / operations を置換し、operation orphan を残さない期待が赤になる。
  - `clearAuditLogs` が detail / operations も消す期待が赤になる。
- TDD mode: Red

### Slice 4 Green: audit V2 write implementation

- 目的: V2 audit write を実装し、既存 runtime の audit lifecycle を復旧する。
- dependencies: Slice 3。
- write set:
  - `src-electron/audit-log-storage-v2-read.ts`
  - `src-electron/persistent-store-lifecycle-service.ts`
  - `src-electron/main.ts`
  - `scripts/tests/audit-log-storage-v2-read.test.ts`
- test target:
  - `npx tsx --test scripts/tests/audit-log-storage-v2-read.test.ts`
  - `npx tsx --test scripts/tests/audit-log-storage.test.ts`
  - `npx tsx --test scripts/tests/audit-log-service.test.ts`
  - `npx tsx --test scripts/tests/session-runtime-service.test.ts`
- acceptance criteria:
  - V2 DB 選択時に `requireAuditLogStorageForWrite()` が read-only error を出さず、V2 storage を writable と判定する。
  - `createAuditLog` は `audit_logs` に preview / counters / token columns を保存し、detail payload は `audit_log_details` に保存する。
  - `operations` は `audit_log_operations` に `seq` 付きで保存する。
  - `updateAuditLog` は対象 id がなければ既存 V1 と同様に throw し、存在する場合は transaction 内で summary / detail / operations を整合更新する。
  - `clearAuditLogs` は `audit_logs` delete を起点に detail / operations を残さない。
- TDD mode: Green

### Slice 5 Review: lifecycle / docs / regression

- 目的: V2 write path の境界、docs、回帰検証を締める。
- dependencies: Slice 2 と Slice 4。
- write set:
  - `src-electron/persistent-store-lifecycle-service.ts`
  - `src-electron/main.ts`
  - `scripts/tests/persistent-store-lifecycle-service.test.ts`
  - `docs/design/database-schema.md`
  - `docs/design/database-v2-migration.md`
  - `docs/plans/20260427-identify-data-loading-optimizations/worklog.md`
  - `docs/plans/20260427-identify-data-loading-optimizations/result.md`
- test target:
  - `npm test`
  - `npm run typecheck`
  - `npm run build`
- acceptance criteria:
  - V1-only DB では既存 V1 storage が選択される。
  - valid V2 DB では V2 session / audit write が使われ、memory は V2 no-op / read-only のまま。
  - docs から「V2 runtime write-path は未切替」という古い記述が消え、今回の境界と out of scope が明記される。
  - active repo plan の checkpoint 15 に対応する検証結果を記録できる。
- TDD mode: Review

## Affected Files

- `src-electron/session-storage-v2-read.ts`
- `src-electron/audit-log-storage-v2-read.ts`
- `src-electron/persistent-store-lifecycle-service.ts`
- `src-electron/main.ts`
- `scripts/tests/session-storage-v2-read.test.ts`
- `scripts/tests/audit-log-storage-v2-read.test.ts`
- `scripts/tests/persistent-store-lifecycle-service.test.ts`
- `scripts/tests/session-storage.test.ts`
- `scripts/tests/audit-log-storage.test.ts`
- `scripts/tests/audit-log-service.test.ts`
- `scripts/tests/session-runtime-service.test.ts`
- `docs/design/database-schema.md`
- `docs/design/database-v2-migration.md`
- `docs/plans/20260427-identify-data-loading-optimizations/worklog.md`
- `docs/plans/20260427-identify-data-loading-optimizations/result.md`

## Docs 更新対象

- `docs/design/database-schema.md`
  - V2 runtime が read-only ではなく session / audit write-capable になったことを反映する。
  - memory は引き続き V2 schema に含めず no-op / read-only であることを残す。
- `docs/design/database-v2-migration.md`
  - migration script boundary は維持しつつ、runtime write path の現在地を追記する。
- `.ai_context/`
  - 公開 contract / architecture summary に V2 write path の記載がある場合のみ更新する。現時点の調査では必須更新対象は未特定。

## Questions Check

- 追加質問: 不要
- 理由: ユーザー指定で今回スコープが確定済み。memory は no-op / read-only、audit summary page / detail lazy load API は out of scope と明示済み。
- questions proposal: 不要

## Risks

- V2 storage class 名が `V2Read` のまま write method を持つ場合、命名と実態がずれる。大規模 rename は別影響を生むため、今回中に rename するかは Review で最小差分を優先して判断する。
- `replaceSessions` / `updateAuditLog` は複数 table 更新のため transaction 境界が弱いと orphan / partially written row が残る。
- `audit_logs.audit_log_count` denormalized counter は現状 read path で強く使われていないが、audit write 時に session 側 counter を更新しない場合は将来の summary page で不整合が見える。
- `raw_items_json` や `assistant_text` の preview / count 抽出ロジックが migration script とずれると、V2 runtime write と migrated data の表示差が出る。

## Validation Strategy

- slice 単位:
  - `npx tsx --test scripts/tests/session-storage-v2-read.test.ts`
  - `npx tsx --test scripts/tests/audit-log-storage-v2-read.test.ts`
  - `npx tsx --test scripts/tests/persistent-store-lifecycle-service.test.ts`
- regression:
  - `npx tsx --test scripts/tests/session-storage.test.ts`
  - `npx tsx --test scripts/tests/audit-log-storage.test.ts`
  - `npx tsx --test scripts/tests/audit-log-service.test.ts`
  - `npx tsx --test scripts/tests/session-runtime-service.test.ts`
- final:
  - `npm test`
  - `npm run typecheck`
  - `npm run build`

## Archive Readiness

- active plan archive destination: `docs/plans/archive/2026/04/20260427-identify-data-loading-optimizations/`
- archive prerequisite for this slice:
  - checkpoint 15 の result / worklog が更新済み
  - `questions.md` status が `質問なし` または `確認済み`
  - V2 write path の validation results が `result.md` に記録済み

## Refactor Classification

- 判定: same-plan prerequisite
- 対象: V2 session / audit storage 内の serialization helper 抽出、transaction helper 整理、writable type guard 調整。
- 理由: V2 write path を安全に実装するための局所整理であり、目的・変更範囲・検証軸が checkpoint 15 に従属する。
- impact scope: `src-electron/session-storage-v2-read.ts`、`src-electron/audit-log-storage-v2-read.ts`、`src-electron/persistent-store-lifecycle-service.ts`、`src-electron/main.ts` と対応 tests。
- validation implications: helper 抽出後も V1 storage tests と V2 read tests を通し、既存 read contract の回帰を確認する。
