# Plan

## Goal

- `/agent` と `/skill` 系 command を WithMate でどこまで共通化できるか整理する
- Codex / GitHub Copilot CLI における agent / skills の扱いを調査する
- WithMate 側で専用実装にする部分と共通実装にする部分を設計 docs に残す

## Scope

- Codex CLI / SDK の agent / skills 関連調査
- GitHub Copilot CLI / SDK の agent / skills 関連調査
- WithMate の slash command / prompt composition / provider adapter への設計反映

## Out of Scope

- 実装変更
- UI 実装
- manual test

## Task List

- [x] Plan を作成する
- [x] Codex の agent / skills を調査する
- [x] Copilot の agent / skills を調査する
- [x] 共通化できる部分と provider 専用部分を整理する
- [x] docs に設計を保存する
- [x] plan 記録を更新する

## Affected Files

- `docs/design/slash-command-integration.md`
- `docs/design/provider-adapter.md`
- `docs/design/skill-command-design.md`

## Risks

- CLI interactive command と prompt-level skill invocation を混同すると責務が崩れる
- `agent` と `skill` は provider ごとに意味が違う可能性がある
- 共通化しすぎると provider-native 機能を潰す

## Design Doc Check

- 状態: 更新対象あり
- 対象候補: `docs/design/slash-command-integration.md`, `docs/design/provider-adapter.md`
- メモ: agent / skill 専用の設計メモを新規追加する
