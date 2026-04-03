# 2026-04-04 Settings Window Shell Refresh

## 目的

- `Settings Window` のカード横幅が window 幅に追従するようにする
- `Memory 管理 Window` と同じ方向の専用 window デザインへ寄せる

## スコープ

- `src/HomeApp.tsx`
- `src/home-components.tsx`
- `src/styles.css`
- 必要な design / checklist 同期

## 進め方

1. current の `Settings Window` shell と scroll 構造を確認する
2. width 固定の原因を外し、window 幅追従の shell へ直す
3. `Memory 管理 Window` と近い見た目になるよう余白と scroll 容器を揃える
4. docs 同期と build 確認を行う
