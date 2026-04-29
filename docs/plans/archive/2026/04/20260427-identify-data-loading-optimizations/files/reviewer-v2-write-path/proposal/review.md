# V2 write path quality review

## Findings

### 1. [High] `replaceSessions` が保持対象 session の audit log も cascade 削除する

- 対象: `src-electron/session-storage-v2-read.ts:463`, `src-electron/session-storage-v2-read.ts:482`, `src-electron/database-schema-v2.ts:120`
- Recommendation: same-plan blocker

`replaceSessions` は既存 `audit_log_count` を読んだ後に `DELETE FROM sessions` を実行し、V2 schema では `audit_logs.session_id` が `ON DELETE CASCADE` のため、次の `nextSessions` に同じ session id が含まれていても既存 audit log / detail / operations が削除される。V1 `SessionStorage.replaceSessions` は `audit_logs` を触らないため、V2 write path の V1 regression になる。

追加確認では、`upsertSession` → `createAuditLog` → 同じ id を含む `replaceSessions` の後に `audit_logs` が 0 件になった。

同一 plan で、`replaceSessions` は全 session delete ではなく、保持する session id の header upsert と message/artifact 再構築、削除対象 session id のみ delete に変える必要がある。テストは「audit log を持つ session を `replaceSessions` で保持した場合、audit log/detail/operations が残る」「除外された session の audit log は cascade で消える」を追加する。

### 2. [High] `sessions.audit_log_count` が audit write path で更新されない

- 対象: `src-electron/audit-log-storage-v2-read.ts:391`, `src-electron/audit-log-storage-v2-read.ts:448`, `src-electron/audit-log-storage-v2-read.ts:510`, `src-electron/session-storage-v2-read.ts:443`, `docs/design/database-v2-migration.md:49`
- Recommendation: same-plan blocker

V2 design は `message_count` / `audit_log_count` を denormalized counter として定義しているが、`createAuditLog` は `audit_logs` / `audit_log_details` / `audit_log_operations` だけを insert し、`sessions.audit_log_count` を increment しない。`clearAuditLogs` も `audit_logs` だけを delete し、counter を 0 に戻さない。`SessionStorageV2Read.upsertSession` は既存 counter を保持する実装になっているため、counter は正本として扱う意図がある一方で audit write がそれを維持していない。

追加確認では、`createAuditLog` 後も対象 session の `audit_log_count` は 0 のままだった。

同一 plan で、audit write transaction 内に session counter 更新を含める必要がある。最低限 `createAuditLog` で対象 session を `+1`、`clearAuditLogs` で全 session を `0` にし、`updateAuditLog` で session id を不変にするなら counter 変更なしを明示テストする。session id 更新を許すなら decrement / increment の両方が必要。

### 3. [Medium] `updateAuditLog` が post-commit の再取得条件で失敗し、失敗応答なのに DB は更新済みになる

- 対象: `src-electron/audit-log-storage-v2-read.ts:448`, `src-electron/audit-log-storage-v2-read.ts:459`, `src-electron/audit-log-storage-v2-read.ts:503`
- Recommendation: same-plan blocker

`UPDATE_AUDIT_LOG_SQL` は `WHERE id = ?` だけで更新し、`session_id` は更新しない。その後 `this.listSessionAuditLogs(input.sessionId).find(...)` で再取得するため、呼び出し側の `input.sessionId` が既存 row と食い違うと transaction は commit 済みなのに `再取得に失敗` を throw する。V1 は `UPDATE ... RETURNING` で id に対する更新結果を返しており、post-commit re-fetch の session mismatch で失敗しない。

追加確認では、既存 row が `session_id = s1` の状態で `updateAuditLog(id, { sessionId: s2, ... })` を呼ぶと throw したが、row の `phase` は更新済みだった。

同一 plan で、更新前に既存 row の session id を取得して `input.sessionId` と一致しない場合は mutation 前に reject する、または更新後の再取得を id ベースに変える必要がある。`id` not found は rollback されること、session mismatch は DB を変えないことをテストで固定する。

### 4. [Medium] V2 audit write の summary column 直接検証が不足している

- 対象: `scripts/tests/audit-log-storage-v2-read.test.ts:505`, `scripts/tests/audit-log-storage-v2-read.test.ts:600`, `scripts/tests/audit-log-storage-v2-read.test.ts:723`
- Recommendation: same-plan blocker

Green test は DTO 復元と child row 件数を確認しているが、review 観点にある `assistant_text_preview` の 500 文字上限、`raw_item_count`、`input_tokens` / `cached_input_tokens` / `output_tokens`、`has_error`、`operation_count` を `audit_logs` summary row で直接 assert していない。実装には該当計算があるが、summary-first schema の目的列なので regress しても現在の tests では見落とす。

同一 plan で、`createAuditLog` と `updateAuditLog` のテストに summary row の直接検証を追加する。特に `assistantText` が 500 文字を超えるケース、`rawItemsJson` が配列の場合と invalid JSON の場合、`usage: null` と usage 有りの両方を固定する。

### 5. [Low] `data-loading-performance-audit.md` の audit summary 記述が現行 V2 schema とずれている

- 対象: `docs/design/data-loading-performance-audit.md:142`, `docs/design/data-loading-performance-audit.md:146`
- Recommendation: same-plan

`audit_logs` の一覧用列として `summary_text` が残っているが、現行 V2 schema の `audit_logs` に `summary_text` はなく、operation summary は `audit_log_operations.summary` にある。また同じ提案ブロックで「詳細 API でのみ取得」と書きつつ、現在の runtime path は既存 IPC contract 維持のため `listSessionAuditLogs` が detail / operations を復元して返す。

同一 plan で、現在 slice の仕様を `assistant_text_preview` / `operation_count` / `raw_item_count` / usage columns へ合わせ、detail lazy load は後続 slice の out of scope として明確化する。

## TDD Evidence Review

- Red evidence は `upsertSession is not a function` / `createAuditLog is not a function` で、V2 adapter に write method を追加する slice の Red として妥当。
- Green evidence は session / audit V2 storage と V1 regression suites、lifecycle / runtime 周辺、`npm run build:electron` を含んでおり、基本経路は妥当。
- ただし上記 findings の通り、audit log を持つ session の `replaceSessions`、`audit_log_count`、`updateAuditLog` mismatch、summary columns の直接 assert が抜けているため、この slice の correctness gate としては追加 Red/Green が必要。

## Same-Plan / Follow-Up

- Same-plan blocker: findings 1, 2, 3, 4
- Same-plan docs sync: finding 5
- New-plan recommendation: なし。いずれも V2 write path slice の correctness / TDD / docs drift であり、独立した検証軸ではなく現在 checkpoint 15 の完了条件に含めるべき。
