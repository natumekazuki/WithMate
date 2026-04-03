# Plan

- task: Session right pane の Generate Memory 表示条件を調整する
- date: 2026-04-04
- owner: Codex

## 目的

- `Generate Memory` を `Memory生成` tab の時だけ表示し、それ以外の tab では非表示にする

## スコープ

- `src/session-components.tsx`
- `docs/design/desktop-ui.md`
- `docs/manual-test-checklist.md`

## チェックポイント

- [x] `Memory生成` tab の時だけ button を表示する
- [x] 他 tab では button を出さない
- [x] docs を同期する
- [x] build を通す
