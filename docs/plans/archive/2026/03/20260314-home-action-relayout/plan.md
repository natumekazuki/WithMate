# Plan

## Goal

- Home の header を削除し、action を各セクションへ再配置する

## Scope

- `Settings` を Home 右上へ移動
- `New Session` を `Recent Sessions` へ移動
- `Add Character` を `Characters` へ移動
- Home の docs 同期

## Task List

- [x] Plan を作成する
- [ ] HomeApp を更新する
- [ ] styles を調整する
- [ ] docs を同期する
- [ ] typecheck/build を通す

## Affected Files

- `src/HomeApp.tsx`
- `src/styles.css`
- `docs/design/desktop-ui.md`
- `docs/design/home-ui-brushup.md`

## Risks

- 上部 action の移動で視線導線が変わるため、実機で密度確認が必要

## Design Doc Check

- 状態: 確認済み
- 対象候補: `docs/design/desktop-ui.md`, `docs/design/home-ui-brushup.md`
- メモ: header 削除後の Home 構造へ更新する
