# Plan

## Goal
- Home の Characters card を session card と同じ操作導線に揃え、UI 全体の配色をフラットで抑えたものにリセットする。

## Scope
- `src/HomeApp.tsx`
- `src/styles.css`
- `docs/design/home-ui-brushup.md`
- `docs/design/desktop-ui.md`
- `docs/manual-test-checklist.md`

## Task List
- [x] Characters card のレイアウトを上詰めに変更する
- [x] `Edit` ボタンを削除し card 全体クリックで editor を開くようにする
- [x] Home を中心に UI トークンの配色をフラットなものへ見直す
- [x] docs 更新と検証を行う

## Affected Files
- src/HomeApp.tsx
- src/styles.css
- docs/design/home-ui-brushup.md
- docs/design/desktop-ui.md
- docs/manual-test-checklist.md

## Risks
- 色トークン変更の影響が Home 以外にも波及する
- button のコントラストを落としすぎると操作性が下がる

## Design Doc Check
- 状態: 確認済み
- 対象候補: docs/design/home-ui-brushup.md, docs/design/desktop-ui.md
- メモ: Home card の操作導線と current visual direction を更新する
