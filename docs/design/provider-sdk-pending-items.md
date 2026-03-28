# Provider SDK Pending Items

- 作成日: 2026-03-25
- 対象: WithMate 実装側ではなく provider SDK surface 待ちで保留している項目の整理

## Purpose

provider 側 SDK の surface 不足で、WithMate では実装しないか provider 限定に留めている項目を一覧化する。  
「未実装」と「現状では実装筋が悪い」を分けて扱うためのメモ。

## Position

- 状態: review note
- current 実装の正本ではなく、SDK surface 待ちで保留している論点を残すための文書として扱う
- 実装済み capability や adapter 境界の正本は `docs/design/provider-adapter.md` と `docs/design/coding-agent-capability-matrix.md` を参照する

## Summary Table

| 項目 | Codex | Copilot | 現在の判断 |
| --- | --- | --- | --- |
| 対話的 approval callback | 未確認 / 未対応 | あり | 共通 UI は作らず、Copilot だけ対話承認 |
| Plan mode 切替 | 未確認 / 未対応 | あり | 共通 UI は見送り |
| Compact API | 未確認 / 未対応 | あり | 共通 UI は見送り |
| account 単位 quota 取得 | 未確認 / 未対応 | あり | Copilot だけ可視化 |
| provider native add-dir remove | 未確認 / 未対応 | 明示 remove surface 未確認 | WithMate 側 allowlist を正本にする |
| apps / mcp / plugins 管理 | surface 未確認 | 一部あり | 読み取り専用も含めて当面見送り |

## Pending Items

### 1. Approval Callback Parity

- Codex SDK には Copilot の `permission.requested` / `permission.completed` 相当の callback surface が見えていない
- そのため `provider-controlled` を SessionWindow 上で都度 approve / deny する共通 UI は作れない
- 現在は:
  - `Copilot`: 対話承認 UI を実装済み
  - `Codex`: approval mode 切替ベース

### 2. Plan / Compact Parity

- Copilot SDK には mode 切替と compact に寄せられる surface がある
- Codex SDK には明示的な `plan` / `compact` API が確認できていない
- 現在は SessionWindow に共通 `Mode` UI を置かない

### 3. Quota / Rate Limit Parity

- Copilot は account 単位 quota を取得できるため `Premium Requests` を可視化済み
- Codex SDK では token usage は見えても、残量や reset 時刻の account quota surface は確認できていない
- Codex 側は SDK 追加か別 API 設計が必要

### 4. Additional Directory Native Control

- Codex は `additionalDirectories` を thread option として渡せる
- Copilot は add-dir 相当の CLI surface はあっても、SDK で個別 remove/update する API は確認できていない
- 現在は WithMate の `allowedAdditionalDirectories` を正本にして UI と添付制御を揃える

### 5. Extensions / MCP / Plugins

- Copilot は list / enable / disable 系 surface が一部ある
- Codex SDK では同等の管理 surface が確認できていない
- 現在は provider 差が大きいため UI は見送り

## Revisit Trigger

次のいずれかが起きたら再調査する。

- `@openai/codex-sdk` に permission callback が追加された
- `@openai/codex-sdk` に plan / compact / quota の明示 API が追加された
- Copilot SDK に add-dir remove/update の明示 API が追加された
- WithMate 側で provider ごとの差を許容してでも必要な UX が出てきた
