# Documentation Map

- 作成日: 2026-03-28
- 対象: `docs/design/` の current 棚卸し

## Goal

`docs/design/` にある文書を、current 実装に対する役割ごとに整理する。  
この文書は、docs 精査で何を正本として残し、何を supporting doc とし、何を統合候補として扱うかを判断するための入口にする。

## Classification

### A. Current Source Of Truth

current 実装の正本として維持する文書。  
仕様変更やコード変更に追従して更新する前提で扱う。

| Doc | Role |
| --- | --- |
| `product-direction.md` | プロダクトの優先順位と current milestone の判断基準 |
| `single-mate-architecture.md` | 4.0.0 SingleMate / Mate Profile / Growth 方針の正本 |
| `mate-storage-schema.md` | 4.0.0 Mate Profile / Growth / provider instruction sync の SQLite schema 正本 |
| `mate-growth-engine.md` | 4.0.0 Growth Candidate / Mate Memory Engine の責務と policy gate の正本 |
| `mate-memory-summary.md` | Memory / Growth 周りを外部検討に渡すための単一 summary |
| `provider-instruction-sync.md` | Mate Profile と provider instruction file 同期方針の正本 |
| `window-architecture.md` | Window 構成と mode 切り替えの正本 |
| `desktop-ui.md` | current UI の全体像 |
| `provider-adapter.md` | provider 差分と adapter 責務 |
| `coding-agent-capability-matrix.md` | current の provider capability 一覧 |
| `memory-architecture.md` | Memory 全体設計の正本 |
| `settings-ui.md` | Settings Window と設定責務 |
| `audit-log.md` | audit 記録の current 仕様 |
| `database-schema.md` | current 保存構造と DB 定義の正本 |
| `model-catalog.md` | model catalog 保存 / 解決ロジック |
| `session-run-lifecycle.md` | session 実行 lifecycle と background task のつながり |

### B. Supporting / Domain Detail

正本を補助する詳細文書。  
単独で入口にするより、関連する A 文書から参照される前提で残す。

| Doc | Role |
| --- | --- |
| `character-management-ui.md` | Character Editor の UI 詳細 |
| `character-storage.md` | character catalog の保存詳細 |
| `character-definition-format.md` | `character.md` / `character-notes.md` の標準構成 |
| `character-update-workspace.md` | character 更新用 workspace と memory extract helper の詳細 |
| `project-memory-storage.md` | Project Memory の storage / promotion / retrieval detail |
| `character-memory-storage.md` | Character Memory と reflection cycle の detail |
| `prompt-composition.md` | coding plane prompt の section / format detail |
| `monologue-provider-policy.md` | 独り言 / character reflection backend の provider 方針 |
| `message-rich-text.md` | message renderer の仕様 |
| `session-character-copy.md` | Session copy slot の詳細 |
| `session-live-activity-monitor.md` | Session 右ペイン activity 表示の詳細 |
| `session-launch-ui.md` | 新規 session 起動 UI の詳細 |
| `electron-session-store.md` | Electron 側 session / audit / memory storage 実装詳細 |
| `electron-window-runtime.md` | BrowserWindow / preload / runtime 詳細 |
| `manual-test-checklist.md` | 実機テスト項目の current 一覧 |
| `provider-usage-telemetry.md` | Copilot quota / context telemetry の詳細 |
| `distribution-packaging.md` | installer / app bundle の packaging 方針 |
| `refactor-roadmap.md` | current リファクタの進行管理 |

### B2. Future Design / Migration Candidate

current 実装の正本ではないが、次の保存構造や migration の採否判断に使う文書。

| Doc | Role |
| --- | --- |
| `database-v2-migration.md` | V1 -> V2 migration と V2 schema 方針 |
| `database-v3-blob-storage.md` | V3 DB と compressed blob store の方針 |

### C. Archived Design Notes

latest 実装とは一致しないが、設計経緯や調査記録として archive に退避した文書。  
current 正本としては扱わず、必要時だけ archive を参照する。

| Doc | Archived View |
| --- | --- |
| `archive/2026/03/character-chat-ui.md` | `product-direction.md` に current 方針が吸収済みのため archive |
| `archive/2026/03/home-ui-brushup.md` | `desktop-ui.md` に current 要件が吸収済みのため archive |
| `archive/2026/03/recent-sessions-ui.md` | `desktop-ui.md` に current 要件が吸収済みのため archive |
| `archive/2026/03/session-window-chrome-reduction.md` | `desktop-ui.md` に current 要件が吸収済みのため archive |
| `archive/2026/03/session-window-layout-redesign.md` | `desktop-ui.md` に current 要件が吸収済みのため archive |
| `archive/2026/03/codex-approval-research.md` | approval surface の調査記録として archive |
| `archive/2026/03/agent-event-ui.md` | event UI の検討メモとして archive |
| `archive/2026/03/skill-command-design.md` | skill command 設計メモとして archive |
| `archive/2026/03/slash-command-integration.md` | slash command 統合検討メモとして archive |
| `archive/2026/03/provider-sdk-pending-items.md` | SDK pending items の review note として archive |
| `archive/2026/03/session-persistence.md` | SQLite / Memory current 実装は `electron-session-store.md` と `database-schema.md` に吸収済みのため archive |

## Next Review Order

docs 精査は次の順で進める。

1. `desktop-ui.md` と UI 系文書の統合方針を決める
2. `window-architecture.md` / `electron-window-runtime.md` / `session-run-lifecycle.md` / `electron-session-store.md` の境界を見直す
3. archive した調査メモから、current 正本へ戻すべき論点が出た時だけ follow-up を切る
4. current docs に新しい historical / review 文書を増やさない運用を維持する

## Notes

- この文書自体は `docs/design/` の案内板として扱う
- 実際に統合や archive を行う時は、個別 task と plan を切って進める
