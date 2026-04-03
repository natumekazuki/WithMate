# 20260404-artifact-details-fold

## 目的

- Session の artifact `Details` が実運用で長くなりすぎる問題を抑える
- `Changed Files` を 1 ブロックでまとめて畳めるようにする
- `operationTimeline` を command 単位で個別に折りたためるようにする

## スコープ

- `src/session-components.tsx`
- `src/styles.css`
- `docs/design/desktop-ui.md`
- `docs/manual-test-checklist.md`
- `docs/task-backlog.md`

## 方針

- artifact block 全体の展開導線は現状の bubble 右上 icon を維持する
- artifact block 内では `Changed Files` を 1 つの details block にまとめ、default closed にする
- `operationTimeline` は item ごとに details 化し、default closed にする
- `Run Checks` は常時表示のまま維持する

## 検証

- `npm run build`
