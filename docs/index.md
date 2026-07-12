# WithMate Rebuild Documentation

WithMate は完全に 0 ベースで作り直す。

現行資源は `old/` に退避済み。新バージョンの設計・実装判断は、この `docs/` 配下を起点に整理する。

## Documents

| Document | Purpose |
| --- | --- |
| `docs/feature-inventory.md` | 現行機能の棚卸しと、新バージョンへ残すかどうかの初期判断 |
| `docs/unresolved-issues.md` | GitHub Issues と Notion Issue DB から拾った未完了項目 |
| `docs/issue-triage.md` | GitHub / Notion Issue を新バージョンへ引き継ぐか捨てるかの判断記録 |
| `docs/plans/20260712-withmate-rebuild-roadmap/plan.md` | ゼロベース再構築の全体checkpoint、依存関係、完了Gate |
| `docs/plans/20260712-cp1-runtime-persistence/plan.md` | CP1 Runtime / Persistence Foundationのslice、依存関係、完了Gate |
| `docs/development/source-comment-guidelines.md` | 新実装のソースコメント、JSDoc、TODO / FIXME / HACKの記載規約 |
| `docs/design/provider-integration.md` | CLI 優先、Provider 接続、会話履歴、実行状態の設計基準 |
| `docs/design/codex-app-server-adapter-contract.md` | Codex App Server の Thread / Turn / item、assistant 分類、interaction、復旧の Adapter 契約 |
| `docs/design/session-run-message-contract.md` | Session / Run / Message / RunEvent の責務、状態遷移、不変条件 |
| `docs/design/multi-agent-orchestration.md` | Multi-Agent の親子 Session、待機、並行実行、結果配送、Auxiliary との境界 |
| `docs/design/multi-agent-persistence.md` | Session / Message / Run、Run output、親子 relation / Delegation / result delivery、ProviderBinding / RunAttempt / RunDispatch、IdempotencyRecord、RunEvent、RunInputDelivery の table、制約、transaction、修復規則 |
| `docs/design/sqlite-schema-lifecycle.md` | 新DBの初期DDL適用、database識別、schema version管理、現行schema間migrationの境界 |
| `docs/design/persistence-worker-lifecycle.md` | Persistence Workerのownership、FIFO、protocol、timeout / cancel、shutdown、crash、payload chunk契約 |
| `schema/sqlite/v1.sql` | WithMate新実装のSQLite schema version 1 table / index / trigger完全DDL |
| `schema/sqlite/manifest-v1.json` | schema version、application ID、table / index / trigger集合の機械可読manifest |
| `docs/investigations/codex-app-server/capability-matrix.md` | Codex App Server の capability と WithMate への対応方針 |
| `docs/investigations/codex-app-server/validation-plan.md` | Codex App Server の検証計画 |
| `docs/investigations/codex-app-server/validation-results.md` | Codex App Server の schema、基本通信、persistent Thread復旧の実測結果 |
| `docs/investigations/github-copilot-acp/validation-plan.md` | GitHub Copilot ACP の別環境検証計画 |
| `docs/investigations/github-copilot-acp/validation-results.md` | GitHub Copilot ACP の検証結果記録 |

## Current Policy

- 現行コード・既存 docs・設定・生成物・依存関係は `old/` に保存する。
- 新実装は root 直下へ改めて作る。
- 新実装は新しい DB file と schema から開始し、旧 DB の data migration、import、compatibility reader は実装しない。旧 DB file は参照、変更、自動削除しない。
- 既存機能は無条件に移植せず、`feature-inventory.md` の判断を見直してから採用する。
- Issue は `unresolved-issues.md` を起点に、新バージョンの backlog へ再分類する。
- 中核 use case は画面に依存しない Application Service として設計し、CLI を先行 client、GUI を後続 client とする。
- 初期 Provider は Codex と GitHub Copilot に限定し、`docs/design/provider-integration.md` を接続方針の正本とする。

## Session Persistence Design Review Set

Session / Run / MessageとMulti-Agent永続化の設計レビューでは、次を1つのまとまりとして扱う。

1. `docs/design/session-run-message-contract.md`
2. `docs/design/multi-agent-orchestration.md`
3. `docs/design/multi-agent-persistence.md`
4. `docs/design/provider-integration.md`
5. `docs/design/codex-app-server-adapter-contract.md`
6. `docs/investigations/codex-app-server/validation-results.md`

このreview setでは、14 table、状態遷移、transaction境界、crash recovery、明示削除、Provider相関、schema version 1の完全DDLを確定範囲とする。初期DDL適用、schema version管理、現行schema間migrationの境界は`docs/design/sqlite-schema-lifecycle.md`を正本とする。Persistence Worker / repository API、Application Service / CLIの具体型、contract testのtest runner統合、自動retention、Copilot ACP runtime mappingは次段階で扱う。
