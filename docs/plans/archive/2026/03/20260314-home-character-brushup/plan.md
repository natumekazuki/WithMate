# Plan

## Goal
- Home の Characters を Recent Sessions と同じ情報設計に寄せ、検索バーと追加 action を同じ行に配置する。検索アイコンは SVG に置き換える。

## Scope
- `src/HomeApp.tsx`
- `src/styles.css`
- `docs/design/home-ui-brushup.md`
- `docs/design/desktop-ui.md`
- `docs/manual-test-checklist.md`

## Task List
- [x] Home の検索 UI 用アイコンを SVG 化する
- [x] Characters に検索入力を追加し `Add Character` と同じ行に配置する
- [x] Characters card のレイアウトを Recent Sessions と同じ温度感へ寄せる
- [x] docs 更新と検証を行う

## Affected Files
- src/HomeApp.tsx
- src/styles.css
- docs/design/home-ui-brushup.md
- docs/design/desktop-ui.md
- docs/manual-test-checklist.md

## Risks
- Home の左右で同じパターンを使うと Characters の情報量には強すぎる可能性がある

## Design Doc Check
- 状態: 確認済み
- 対象候補: docs/design/home-ui-brushup.md, docs/design/desktop-ui.md
- メモ: Home の Characters 検索と action 配置を current behavior に合わせる
