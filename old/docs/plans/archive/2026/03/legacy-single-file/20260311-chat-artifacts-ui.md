# Chat Artifact UI 整理計画

- 作成日: 2026-03-11
- 対象: 作業チャット内への変更内容・実行サマリ集約

## Goal

React モックの情報量を減らしつつ、`Codex` らしい作業可視性を保つ。  
常設の `Activity` / `Changed Files` パネルは撤去し、assistant の返答カード内に「このターンで何を変えたか」「何を実行したか」を要約表示する。

## Task List

- [x] チャット内 artifact summary 方針を設計ドキュメントへ反映する
- [x] React モックから常設の `Activity` / `Changed Files` 面を撤去する
- [x] assistant message に変更ファイル一覧と実行サマリを表示できるよう型を更新する
- [x] `Chat + Stream` 主軸へレイアウトを整理する
- [x] 関連ドキュメントを更新する
- [x] `npm run typecheck` と `npm run build` を実行する

## Affected Files

- `docs/plans/20260311-chat-artifacts-ui.md`
- `docs/design/agent-event-ui.md`
- `docs/design/ui-react-mock.md`
- `src/App.tsx`
- `src/styles.css`

## Design Check

既存の `AgentEvent` UI 方針を更新し、以下を整理する。

- assistant message にぶら下がる artifact summary の役割
- 常設面として残す情報と、会話ターン内に内包する情報の境界
- 将来 diff を開く導線の置き場所

## Risks

- 作業ログを要約しすぎると、TUI 的な時系列追跡が弱く感じられる可能性がある
- 1 つの assistant message に情報を寄せすぎると、返答カード自体が重くなる可能性がある
- 後続で実イベント接続した際に、ターン単位の集約ロジックが必要になる

## Notes / Logs

- 2026-03-11: 常設パネルで `Activity` と `Changed Files` を見せる案は、Character Stream と並べたときに情報面が増えすぎる懸念が出た。
- 2026-03-11: assistant message に `Turn Summary` をぶら下げる構成へ切り替え、変更内容と実行サマリを会話ターン内へ集約した。
- 2026-03-11: `npm run typecheck` と `npm run build` を実行し、モック更新後も通過を確認した。
