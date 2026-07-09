# Plan

## Goal

- SessionWindow の chrome を削減し、message viewport を広げる
- `header` を薄い `Top Bar` に整理し、管理操作は必要時だけ展開できるようにする
- `Action Dock` を compact / expanded に分け、通常時は chat 面積を優先する

## Scope

- `src/App.tsx` の SessionWindow header / work surface / action dock 再構成
- `src/styles.css` の SessionWindow chrome reduction 調整
- `docs/design/desktop-ui.md`、`docs/design/session-window-layout-redesign.md`、`docs/design/session-window-chrome-reduction.md`、`docs/manual-test-checklist.md` の同期

## Out of Scope

- `Latest Command` の data mapping 変更
- `Character Stream` 本体実装
- Home / Character Editor / Diff Window の改修

## Task List

- [x] plan を作成する
- [x] header を thin strip + expand/collapse 前提へ組み替える
- [x] `Action Dock` に compact / expanded を実装する
- [x] outer card / padding / gap を削減して message viewport を広げる
- [x] docs / manual test を同期する
- [x] `npm run typecheck` と `npm run build` で検証する

## Affected Files

- `src/App.tsx`
- `src/styles.css`
- `docs/design/desktop-ui.md`
- `docs/design/session-window-layout-redesign.md`
- `docs/design/session-window-chrome-reduction.md`
- `docs/manual-test-checklist.md`
- `docs/plans/archive/2026/03/20260322-session-window-chrome-reduction-implementation/*`

## Risks

- dock collapse の条件が強すぎると入力中に意図せず閉じる可能性がある
- header を削りすぎると rename / delete / audit への導線が分かりにくくなる可能性がある
- work surface の panel 撤去で dark background 上の境界が弱くなり、右 pane や message list の視認性が落ちる可能性がある

## Design Doc Check

- 状態: 更新予定
- 対象: `docs/design/desktop-ui.md`, `docs/design/session-window-layout-redesign.md`, `docs/design/session-window-chrome-reduction.md`
- メモ: SessionWindow の面構成と操作面の常時表示方針が変わるため docs 更新が必要
