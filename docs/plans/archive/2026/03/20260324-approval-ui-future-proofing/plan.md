# Plan

## Goal

- Copilot の承認要求を Session UI で扱う follow-up task を切る
- Codex には同等の callback surface がない前提で、将来追加されても崩れない approval UI contract を定義する
- provider ごとの差を UI と main process の責務分離で吸収する方針を固める

## Scope

- `@github/copilot-sdk` の permission callback を前提にした承認 UI の task 分解
- `@openai/codex-sdk` の現行 approval 制約を踏まえた代替 UX の整理
- provider-neutral な approval UI state / action contract の設計方針整理

## Out of Scope

- 実装変更
- 実機 manual test
- Codex CLI / SDK の未公開 surface を前提にした先行実装

## Task List

- [x] Plan を作成する
- [x] Copilot / Codex の approval surface 差分を確認する
- [x] 共通 UI contract と provider 別 adapter 責務を整理する
- [x] Session UI の approval pending / retry banner の wireframe 相当を設計する
- [x] main process と renderer の approval request state 受け渡しを設計する
- [x] design doc 更新対象を確定する

## Affected Files

- `docs/design/provider-adapter.md`
- `docs/design/coding-agent-capability-matrix.md`
- `docs/design/agent-event-ui.md`
- `src/App.tsx`
- `src-electron/copilot-adapter.ts`
- `src-electron/codex-adapter.ts`
- `src-electron/main.ts`

## Risks

- `承認待ち` と `approval を変えて再実行` を同一 semantics として扱うと、Codex 側の挙動を誤認させる
- Copilot だけ granular approval を持つ current state で UI を共通化しすぎると、provider 差分が隠れて保守しづらくなる
- 将来 Codex SDK に callback が入っても、現在の state model が `retry 前提` に寄りすぎていると差し替えコストが増える

## Design Doc Check

- 状態: 更新対象あり
- 対象候補: `docs/design/provider-adapter.md`, `docs/design/coding-agent-capability-matrix.md`, `docs/design/agent-event-ui.md`
- メモ: approval UI の event / state / action を provider-neutral に再記述する必要がある
