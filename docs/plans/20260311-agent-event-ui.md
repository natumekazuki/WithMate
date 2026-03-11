# Agent Event UI モック実装計画

- 作成日: 2026-03-11
- 対象: React モックにおける `Activity` / `Changed Files` 表示の追加

## Goal

`Codex` の TUI で見える「いま何をしているか」を、WithMate の React モックでも把握できるようにする。  
具体的には、会話本文とは別に `AgentEvent` ベースの `Activity` と `Changed Files` を常設表示し、`Character Stream` と共存できるレイアウトへ再構成する。

## Task List

- [x] `AgentEvent` UI の設計ドキュメントを `docs/design/` に作成する
- [x] React モックに `Activity` タイムラインを追加する
- [x] React モックに `Changed Files` パネルを追加する
- [x] セッションごとにイベント・変更ファイルのダミーデータを持てるよう型を更新する
- [x] 既存の `Work Chat || Character Stream` 構成を崩さずにレイアウトを調整する
- [x] 関連ドキュメントを更新する
- [x] `npm run typecheck` と `npm run build` を実行する

## Affected Files

- `docs/plans/20260311-agent-event-ui.md`
- `docs/design/agent-event-ui.md` (新規予定)
- `docs/design/ui-react-mock.md`
- `src/App.tsx`
- `src/styles.css`

## Design Check

UI に新しい責務を追加するため、実装前に `docs/design/agent-event-ui.md` を作成する。  
このドキュメントでは少なくとも以下を整理する。

- `AgentEvent` の最低限のイベント分類
- `Work Chat` / `Activity` / `Changed Files` / `Character Stream` の役割分離
- モック段階で見せる情報と、後続で実データ接続する際の拡張点

## Risks

- 情報面を増やしすぎると、Character Stream の存在感が落ちる可能性がある
- 実イベントの粒度が SDK / CLI で異なるため、後続で UI の文言や粒度調整が必要になる可能性がある
- モック段階で見せた情報量が、そのまま実装コスト期待値として受け取られる可能性がある

## Notes / Logs

- 2026-03-11: `Codex` TUI に近い開発体験を出すには、チャット本文とは別に `AgentEvent` を first-class に表示する方針を採用した。
- 2026-03-11: React モックを `Work Chat + Activity + Changed Files + Character Stream` の4面構成へ再編した。
- 2026-03-11: 4面構成は情報量が増えすぎたため、次段で assistant message 内の `Turn Summary` へ再整理する方針に切り替えた。
