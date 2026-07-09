# Plan

## Goal

- `GitHub Copilot` provider の tool 実行が `Latest Command` と audit `operations` で読める状態にする
- `shell` 固定の判定をやめ、Copilot の provider-native tool を WithMate の可視化用 operation へ正規化する
- 実行中の step と完了後の監査ログで同じ summary が見える状態に揃える

## Scope

- `src-electron/copilot-adapter.ts` の tool event 正規化
- `scripts/tests/copilot-adapter.test.ts` の回帰テスト追加
- 必要な design doc / plan 記録更新

## Out Of Scope

- `rawItemsJson` のフィルタリング
- Copilot の file / image attachment 対応
- slash command 実装

## Task List

- [x] Plan を作成する
- [x] Copilot sample event から command / tool 可視化対象を整理する
- [x] `Latest Command` と audit `operations` へ出す summary 生成を実装する
- [x] Copilot tool 名ごとの回帰テストを追加する
- [x] docs と plan 記録を更新する

## Affected Files

- `src-electron/copilot-adapter.ts`
- `scripts/tests/copilot-adapter.test.ts`
- `docs/design/provider-adapter.md`
- `docs/plans/20260323-copilot-command-visibility/`

## Risks

- shell command と file-write tool を同じ `command_execution` に寄せると、表示語彙が粗くなりすぎる
- tool 名ごとの分岐を増やしすぎると Copilot SDK 側 schema 変更に弱くなる
