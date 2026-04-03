# Plan

- task: Session header と Generate Memory ボタンの見た目を調整する
- date: 2026-04-04
- owner: Codex

## 目的

- `Generate Memory` の文字が背景に埋もれないようにする
- expanded header から `Close` を外す
- `Delete` を右端で孤立させて危険操作として分離する

## スコープ

- `src/session-components.tsx`
- `src/App.tsx`
- `src/styles.css`
- `docs/design/desktop-ui.md`
- `docs/manual-test-checklist.md`

## チェックポイント

- [x] `Generate Memory` の可読性を上げる
- [x] header から `Close` を外す
- [x] `Delete` を右端で孤立させる
- [x] docs を同期する
- [x] build を通す
