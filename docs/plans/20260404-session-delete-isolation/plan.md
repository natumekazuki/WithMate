# Plan

- task: Session header の Delete を独立列へ戻す
- date: 2026-04-04
- owner: Codex

## 目的

- expanded header で `Delete` が他の操作と一緒に左へ戻らないよう、独立した右端列へ固定する

## スコープ

- `src/session-components.tsx`
- `src/styles.css`

## チェックポイント

- [x] `Delete` を header の独立列へ分離する
- [x] 狭幅時の縦積みを壊さない
- [x] build を通す
