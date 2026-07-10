# WithMate Rebuild Documentation

WithMate は完全に 0 ベースで作り直す。

現行資源は `old/` に退避済み。新バージョンの設計・実装判断は、この `docs/` 配下を起点に整理する。

## Documents

| Document | Purpose |
| --- | --- |
| `docs/feature-inventory.md` | 現行機能の棚卸しと、新バージョンへ残すかどうかの初期判断 |
| `docs/unresolved-issues.md` | GitHub Issues と Notion Issue DB から拾った未完了項目 |
| `docs/issue-triage.md` | GitHub / Notion Issue を新バージョンへ引き継ぐか捨てるかの判断記録 |
| `docs/design/provider-integration.md` | CLI 優先、Provider 接続、会話履歴、実行状態の設計 baseline |
| `docs/design/session-run-message-contract.md` | Session / Run / Message / RunEvent の責務、状態遷移、不変条件 |
| `docs/design/multi-agent-orchestration.md` | Multi-Agent の親子 Session、待機、並行実行、結果配送、Auxiliary との境界 |
| `docs/plans/20260711-multi-agent-detailed-design-entry.md` | Multi-Agent の詳細設計を Persistence から開始するための入口と進行順 |
| `docs/investigations/codex-app-server/capability-matrix.md` | Codex App Server の capability と WithMate への対応方針 |
| `docs/investigations/codex-app-server/validation-plan.md` | Codex App Server の検証計画 |
| `docs/investigations/codex-app-server/validation-results.md` | Codex App Server の schema 調査・基本通信結果 |
| `docs/investigations/github-copilot-acp/validation-plan.md` | GitHub Copilot ACP の別環境検証計画 |
| `docs/investigations/github-copilot-acp/validation-results.md` | GitHub Copilot ACP の検証結果記録 |

## Current Policy

- 現行コード・既存 docs・設定・生成物・依存関係は `old/` に保存する。
- 新実装は root 直下へ改めて作る。
- 既存機能は無条件に移植せず、`feature-inventory.md` の判断を見直してから採用する。
- Issue は `unresolved-issues.md` を起点に、新バージョンの backlog へ再分類する。
- 中核 use case は画面に依存しない Application Service として設計し、CLI を先行 client、GUI を後続 client とする。
- 初期 Provider は Codex と GitHub Copilot に限定し、`docs/design/provider-integration.md` を接続方針の正本とする。
