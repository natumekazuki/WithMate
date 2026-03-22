# Plan

## Goal

- SessionWindow が白画面になる原因を特定し、DB 初期化なしで復旧できるなら局所修正で戻す

## Scope

- `src/App.tsx` / `src/styles.css` の recent 変更確認
- renderer 例外や layout 実装由来の不具合調査
- 必要最小限の bug fix

## Out of Scope

- 無関係な UI polish
- DB schema 変更
- Home / Character Editor の改修

## Task List

- [x] 調査用 plan を作成する
- [x] 白画面の原因を特定する
- [x] 必要な局所修正を入れる
- [x] 検証と記録を行う

## Affected Files

- `src/App.tsx`
- `src/styles.css`
- `docs/plans/20260322-session-window-white-screen-debug/*`

## Risks

- renderer 例外が複数あると 1 箇所直しても白画面が残る可能性がある
- 未コミットの wide layout 差分と原因切り分けが混ざる可能性がある

## Design Doc Check

- 状態: 更新不要
- 対象候補: `docs/design/desktop-ui.md`, `docs/design/session-window-layout-redesign.md`
- メモ: wide layout の仕様変更ではなく、Session 読み込み前の null 参照を防ぐ局所 bug fix のため docs 更新は不要
