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
| `window-architecture.md` | Window 構成と mode 切り替えの正本 |
| `desktop-ui.md` | current UI の全体像 |
| `provider-adapter.md` | provider 差分と adapter 責務 |
| `coding-agent-capability-matrix.md` | current の provider capability 一覧 |
| `memory-architecture.md` | Memory 全体設計の正本 |
| `project-memory-storage.md` | Project Memory の保存 / retrieval 詳細 |
| `character-memory-storage.md` | Character Memory と reflection cycle の正本 |
| `prompt-composition.md` | coding plane prompt の組み立て順 |
| `settings-ui.md` | Settings Window と設定責務 |
| `audit-log.md` | audit 記録の current 仕様 |
| `database-schema.md` | current 保存構造と DB 定義の正本 |
| `model-catalog.md` | model catalog 保存 / 解決ロジック |
| `session-run-lifecycle.md` | session 実行 lifecycle と background task のつながり |
| `session-persistence.md` | session 永続化の責務分離 |
| `provider-usage-telemetry.md` | Copilot usage telemetry の current 仕様 |

### B. Supporting / Domain Detail

正本を補助する詳細文書。  
単独で入口にするより、関連する A 文書から参照される前提で残す。

| Doc | Role |
| --- | --- |
| `character-management-ui.md` | Character Editor の UI 詳細 |
| `character-storage.md` | character catalog の保存詳細 |
| `monologue-provider-policy.md` | monologue / character reflection の provider 方針 |
| `message-rich-text.md` | message renderer の仕様 |
| `session-character-copy.md` | Session copy slot の詳細 |
| `session-live-activity-monitor.md` | Session 右ペイン activity 表示の詳細 |
| `session-launch-ui.md` | 新規 session 起動 UI の詳細 |
| `electron-session-store.md` | Electron 側 session / audit / memory storage 実装詳細 |
| `electron-window-runtime.md` | BrowserWindow / preload / runtime 詳細 |
| `manual-test-checklist.md` | 実機テスト項目の current 一覧 |
| `refactor-roadmap.md` | current リファクタの進行管理 |

### C. Research / Capability / Review Hold

current 実装の正本ではないが、判断材料として残す文書。  
更新頻度は低く、supporting doc よりも `研究メモ` に近い位置づけ。

| Doc | Role |
| --- | --- |
| `codex-approval-research.md` | Codex approval surface の調査記録 |
| `codex-capability-matrix.md` | Codex 観点の capability 詳細 |
| `agent-event-ui.md` | event UI の検討メモ |
| `skill-command-design.md` | skill command 設計メモ |
| `slash-command-integration.md` | slash command の統合検討 |
| `provider-sdk-pending-items.md` | SDK surface 待ち項目の review note |

### D. Merge / Review Candidates

current 実装の正本としては粒度が細かすぎる、または役割が `desktop-ui.md` / `window-architecture.md` / `product-direction.md` と重なりやすい文書。  
今後は単独維持ではなく、統合または archive を検討する。

| Doc | Current View |
| --- | --- |
| `character-chat-ui.md` | `product-direction.md` を current 正本にして historical note 化する候補 |
| `home-ui-brushup.md` | `desktop-ui.md` を current 正本にして historical note 化する候補 |
| `recent-sessions-ui.md` | `desktop-ui.md` を current 正本にして historical note 化する候補 |
| `session-window-chrome-reduction.md` | `desktop-ui.md` を current 正本にして historical note 化する候補 |
| `session-window-layout-redesign.md` | `desktop-ui.md` を current 正本にして historical note 化する候補 |

## Next Review Order

docs 精査は次の順で進める。

1. `desktop-ui.md` と UI 系文書の統合方針を決める
2. `window-architecture.md` / `electron-window-runtime.md` / `session-run-lifecycle.md` の境界を見直す
3. provider / capability / research 系文書の正本と supporting を切り分ける
4. Character / product ideation 系の古い文書を統合または archive する

## Notes

- この文書自体は `docs/design/` の案内板として扱う
- 実際に統合や archive を行う時は、個別 task と plan を切って進める
