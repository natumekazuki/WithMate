# Provider SDK Pending Items

- 作成日: 2026-04-01
- 対象: provider SDK surface の current 実装状況

## 目的

- provider SDK 由来の parity gap を current 実装基準で整理する
- backlog の `sdk-pending` と GitHub issue の接続先を 1 枚に寄せる

## Copilot SDK

| 項目 | 状況 | メモ |
| --- | --- | --- |
| permission request | 実装済み | `provider-controlled` で approval card を出し、`approve / deny` を返す |
| pending elicitation | 実装済み | `elicitation.requested` を Session pending bubble の form / url UI に変換し、`accept / decline / cancel` を返す |
| quota telemetry | 実装済み | `assistant.usage.quotaSnapshots` と `client.rpc.account.getQuota()` を併用する |
| context telemetry | 実装済み | `session.usage_info` を session local telemetry として保持する |
| rich command timeline | 未対応 | current UI は `Latest Command` + `CONFIRMED Details` までに留める |
| slash command 吸収 | 未対応 | `#10` と `copilot-rollout` で継続検討する |
| background task parity | 未対応 | `#17` の `/tasks` 調査待ち |

## Codex SDK

| 項目 | 状況 | メモ |
| --- | --- | --- |
| approval policy | 実装済み | provider-neutral approval mode を CLI policy へ写像する |
| app-level pending elicitation | 未対応 | current surface では Copilot のような form / url pending item は持たない |

## current 方針

- pending item は provider-native wording を直接 UI へ露出せず、WithMate の `LiveSessionRunState` へ正規化して扱う
- `approvalRequest` と `elicitationRequest` は別 state とし、pending bubble 内で同居できる形を維持する
- provider SDK 側で richer event が増えても、右 pane は `Latest Command` 中心の compact UI を維持する

## 接続先

- `docs/design/provider-adapter.md`
- `docs/design/desktop-ui.md`
- `docs/task-backlog.md`
