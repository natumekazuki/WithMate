# Plan

## Goal

- SessionWindow の余白と chrome を削り、chat viewport を広げる target design を定義する

## Scope

- `header` の薄型化 / collapse 方針
- `Action Dock` の collapse 方針
- main card 撤去を含む viewport 拡張方針
- 関連 design doc の更新

## Out of Scope

- 実装コードの変更
- `Character Stream` 本体実装
- provider adapter や liveRun schema の変更

## Task List

- [x] plan を作成する
- [ ] SessionWindow chrome reduction の target design を文書化する
- [ ] `docs/design/desktop-ui.md` と関連 design doc へ反映する
- [ ] 次の実装着手条件を整理する

## Affected Files

- `docs/design/desktop-ui.md`
- `docs/design/session-window-layout-redesign.md`
- `docs/design/session-window-chrome-reduction.md`
- `docs/plans/archive/2026/03/20260322-session-window-chrome-reduction/*`

## Risks

- collapse を入れすぎると操作 discoverability が下がる
- header / dock の閉じ方が増えると state 管理が複雑になる
- panel を外しすぎると dark theme の面構成が弱くなる

## Design Doc Check

- 状態: 更新予定
- 対象: `docs/design/desktop-ui.md`, `docs/design/session-window-layout-redesign.md`
- メモ: SessionWindow の current design を次フェーズの target design に更新する
