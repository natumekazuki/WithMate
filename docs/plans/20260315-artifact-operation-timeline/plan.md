# Plan

## Goal

- `Details` を開いたときに、command と `agent_message` を同じ流れの中で読めるようにする

## Scope

- artifact の view model 拡張
- Session `Details` UI の operation timeline 化
- design doc / 実機テスト項目の同期

## Task List

- [x] 現状の `Details` と artifact の型を確認する
- [x] artifact に operation timeline を追加する
- [x] Session `Details` を operation timeline 表示へ変更する
- [ ] 変更内容を検証する

## Affected Files

- `src/app-state.ts`
- `src-electron/codex-adapter.ts`
- `src/App.tsx`
- `src/styles.css`
- `docs/design/desktop-ui.md`
- `docs/design/agent-event-ui.md`
- `docs/manual-test-checklist.md`

## Risks

- file change は `Changed Files` と timeline の両方に現れるため、情報量が増える
- 既存 session に残っている旧 artifact との後方互換が必要

## Design Doc Check

- 状態: 確認済み
- 対象候補: `docs/design/desktop-ui.md`, `docs/design/agent-event-ui.md`, `docs/manual-test-checklist.md`
- メモ: Turn Summary の構造が変わるため、現行 UI 文書と実機確認項目を更新する
