# Plan

## Goal

- Session Window に wide desktop 向けの 2 カラム layout を実装する
- 左を conversation column、右を context rail とし、draggable splitter で幅調整できるようにする
- `Activity Monitor` を右 rail 上段へ移し、最新 assistant turn を見る `Turn Inspector` を右 rail 下段へ実装する

## Scope

- `src/App.tsx` の Session Window DOM 再編
- `src/styles.css` の wide layout / splitter / turn inspector スタイル実装
- `docs/design/desktop-ui.md`、`docs/manual-test-checklist.md` の同期

## Out of Scope

- `Character Stream` 本体 UI 実装
- provider adapter や persistence schema の変更
- Home / Character Editor / Diff の layout 変更

## Task List

- [x] 実装 plan を作成する
- [x] Session Window を conversation column / context rail の 2 カラムへ再編する
- [x] draggable splitter と wide / narrow fallback を実装する
- [x] `Turn Inspector` を latest assistant turn ベースで実装する
- [x] docs と manual test を同期する
- [x] 検証を実施する

## Affected Files

- `src/App.tsx`
- `src/styles.css`
- `docs/design/desktop-ui.md`
- `docs/design/session-window-layout-redesign.md`
- `docs/manual-test-checklist.md`

## Risks

- DOM 再編で message list / composer の高さ計算が崩れる可能性がある
- splitter drag state が rerender と競合すると scroll や selection が不安定になる可能性がある
- latest assistant turn を inspector に寄せる時、inline artifact detail と情報二重化が起きる可能性がある

## Design Doc Check

- 状態: 更新対象あり
- 対象: `docs/design/desktop-ui.md`, `docs/design/session-window-layout-redesign.md`, `docs/manual-test-checklist.md`
- メモ: 実装結果に合わせて wide desktop の正本仕様と manual test を更新する
