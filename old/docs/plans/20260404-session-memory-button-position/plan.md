# Plan

- task: Session right pane の Generate Memory ボタン位置を調整する
- date: 2026-04-04
- owner: Codex

## 目的

- `Memory生成` 表示中だけ `Generate Memory` を 1 段下へ移し、`Latest Command` などの見出し幅を圧迫しないようにする

## スコープ

- `src/session-components.tsx`
- `src/styles.css`
- `docs/design/desktop-ui.md`
- `docs/manual-test-checklist.md`

## チェックポイント

- [x] `Memory生成` tab 時だけ `Generate Memory` を 2 行目へ移動する
- [x] それ以外の tab では既存レイアウトを維持する
- [x] docs を同期する
- [x] build を通す
