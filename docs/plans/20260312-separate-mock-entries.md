# Separate Mock Entries Plan

- 作成日: 2026-03-12
- 対象: React モックを `Home` / `Session` の別 entry に分離する
- 参照:
  - `docs/design/window-architecture.md`
  - `docs/design/ui-react-mock.md`

## Goal

現在の `Home Window` / `Session Window` 同時 preview モックを、
Vite 上でも別 entry / 別 URL として分離する。
これにより、Electron 実装前の段階でも `Home` と `Session` の起動面を分けて検証できるようにする。

## Task List

- [x] 現在のモック state と data を共有モジュールへ切り出す
- [x] `Home` 用 entry と `Session` 用 entry を追加する
- [x] Vite で複数 HTML entry を扱えるように設定する
- [x] `Home` と `Session` のモック画面をそれぞれ独立表示できるようにする
- [x] 画面間の導線を mock 向けに整理する
- [x] design docs を実装に合わせて更新する
- [x] typecheck / build で確認する

## Affected Files

- `src/` 配下の mock UI 関連ファイル
- `index.html`
- `vite.config.ts`
- `docs/design/ui-react-mock.md`
- `docs/plans/20260312-separate-mock-entries.md`

## Design Check

- 既存 Design Doc で十分
- `docs/design/window-architecture.md` の責務分離を保ったまま、モックの entry 分離だけを進める

## Risks

- 共有 state を切り出さずに entry を増やすと、Home と Session のモックがすぐ乖離する
- Vite の multi-page 設定を雑に入れると、既存の起動方法が分かりにくくなる
- Electron 本実装では `BrowserWindow` 管理になるため、entry 分離と window lifecycle を混同しないよう注意が必要

## Proposed Direction

- `src/mock-data/` のような共有モジュールへ session / character / helper を分離する
- `index.html` / `session.html` の 2 entry を用意する
- `src/main.tsx` と `src/session-main.tsx` を用意する
- Home 側には `Session Window を開く想定のリンク / ボタン` を置く
- Session 側は 1 session に集中した作業画面として切り出す

## Notes / Logs

- 直前のコミット `249438c` では 1 page 内の疑似 2-window preview まで進めた
- 今回はその次段階として、preview 自体を別 entry に分ける
- `src/mock-data.ts` に session / character / helper を切り出し、Home と Session の両方から共有する構成にした
- `index.html` は Home、`session.html` は Session として分離し、Vite build も multi-page input へ更新した
- モックの共有状態は `localStorage` ベースにして、Home で作成した session を Session 側からも読めるようにした
