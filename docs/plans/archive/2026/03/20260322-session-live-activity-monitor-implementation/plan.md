# Plan

## Goal

- Session Window の pending bubble から `live run step` 一覧を分離し、composer 直上の `Activity Monitor` として実装する
- chat 本文と command 実況の両方で最新状態を見失いにくい UI にする

## Scope

- `src/App.tsx` の pending / live run 描画変更
- `src/styles.css` の `Activity Monitor` スタイル追加
- design docs / manual test / plan 記録の同期

## Out of Scope

- provider adapter の event schema 変更
- artifact timeline / Audit Log の構造変更
- `Activity Monitor` の resize handle 実装

## Task List

- [x] Plan を作成する
- [x] pending bubble と `Activity Monitor` の責務を実装へ落とす
- [x] `Activity Monitor` の scroll / follow を実装する
- [x] docs と manual test を同期する
- [x] 検証を実施する

## Affected Files

- `src/App.tsx`
- `src/styles.css`
- `docs/design/desktop-ui.md`
- `docs/design/session-live-activity-monitor.md`
- `docs/manual-test-checklist.md`

## Risks

- monitor の高さが大きすぎると message list の可視範囲が狭くなる
- scroll / follow の state を増やしすぎると挙動が分かりにくくなる
- `running -> error / canceled` の遷移時に monitor の消え方が不自然になる可能性がある

## Design Doc Check

- 状態: 更新対象あり
- 対象候補: `docs/design/desktop-ui.md`, `docs/design/session-live-activity-monitor.md`, `docs/manual-test-checklist.md`
- メモ: 実装結果に合わせて `Activity Monitor` の位置と follow 挙動を正本へ反映する
