# Plan

- task: Session header と right pane の高さ配分を調整する
- date: 2026-04-04
- owner: Codex

## 目的

- expanded header で `Delete` を右端へ孤立させる
- expanded header 時でも `Memory生成` などの main pane が高さを最大限使い、`Premium Requests / Context` は最小限の高さに留める

## スコープ

- `src/session-components.tsx`
- `src/styles.css`
- `docs/design/desktop-ui.md`
- `docs/manual-test-checklist.md`

## チェックポイント

- [x] `Delete` を右端へ分離する
- [x] expanded header 時の right pane 行配分を修正する
- [x] docs を同期する
- [x] build を通す
