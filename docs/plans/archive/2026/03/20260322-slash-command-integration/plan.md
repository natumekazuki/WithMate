# Plan

## Goal

- Codex で現在使える `"/"` コマンドを調査する
- GitHub Copilot CLI で現在使える `"/"` コマンドを調査する
- SDK 経由で `"/"` コマンドをどう扱うべきかを整理し、WithMate 側の実装方針を docs に残す

## Scope

- Codex CLI / SDK の slash command 調査
- GitHub Copilot CLI / SDK の slash command 調査
- WithMate 側の command routing / adapter 分担整理
- design docs / research docs 更新

## Out of Scope

- slash command の実装
- provider adapter のコード変更
- manual test

## Task List

- [x] Plan を作成する
- [x] Codex の slash command を調査する
- [x] Copilot CLI の slash command を調査する
- [x] SDK 経由での扱いを整理する
- [x] WithMate への実装方針を docs 化する
- [x] plan 記録を更新する

## Affected Files

- `docs/design/provider-adapter.md`
- `docs/design/codex-approval-research.md`
- `docs/design/slash-command-integration.md`

## Risks

- CLI の対話 UI と SDK 経由の headless 実行を混同すると設計を誤る
- provider ごとに slash command の種類と責務が違う可能性がある
- app command と provider command の境界が曖昧だと UI / main process / adapter の責務がぶれる

## Design Doc Check

- 状態: 更新対象あり
- 対象候補: `docs/design/provider-adapter.md`, `docs/design/codex-approval-research.md`
- メモ: slash command 専用の design doc を新規追加する
