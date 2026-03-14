# Goal
Diff Viewer で長い 1 行が見切れないようにし、GitHub Desktop ライクな横スクロール前提の閲覧体験を整える。

# Task List
- [x] Diff Viewer のヘッダーと本文を同一横スクロールに揃える
- [x] 長い 1 行でも折り返さず読めるように CSS を調整する
- [x] 必要なら `Open In Window` を後で足せる構造に整える
- [x] 関連 design docs を更新する
- [x] `npm run typecheck` / `npm run build` / `npm run build:electron` を通す

# Notes / Logs
- `diff-columns-head` と `diff-grid` を同じ `diff-scroll-region` に入れて、横スクロールを共有する形にした。
- code cell の ellipsis をやめて、`white-space: pre` のまま横スクロールで読む方針にした。

# Affected Files
- `src/App.tsx`
- `src/styles.css`
- `docs/design/ui-react-mock.md`
- `docs/plans/20260314-diff-horizontal-scroll.md`

# Risks
- 横スクロールを強くすると、狭い画面では縦横ともにスクロールが増えて操作しづらくなる
- ヘッダーと本文のレイアウトを分けたままだと、列幅がずれて逆に読みにくくなる

# Design Check
- `docs/design/ui-react-mock.md` の更新が必要

- 2026-03-14: 
pm run typecheck / 
pm run build / 
pm run build:electron を実行し、通過を確認した。
